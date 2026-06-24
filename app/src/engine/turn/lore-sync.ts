import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addCharacterIndexRow,
  applyIndexStatusUpdates,
  applyPointsDelta,
  parseProtagonist,
  rewriteNpcFile,
} from "../context.js";
import { loadDungeonLore, registerAnnouncedDungeon } from "../dungeon.js";
import type { Logger } from "../../logger.js";
import { listLoreIds, loreDir, rewriteLoreWiki } from "../lore.js";
import { parseCharacterIndex } from "../context.js";
import { parseLoreSyncOutput } from "../schema.js";
import { summarizeNpcStatus } from "../npc-status-summary.js";
import {
  ENTITY_CATEGORY_TO_LORE,
  callLoreRewrite,
  callProtagonistRewrite,
  rewriteLoreEntity,
  type LoreRewriteContext,
  type LoreRewriteResult,
} from "./lore-rewrite.js";
import { reconcileEntityCategories, sanitizeTouchedEntities } from "./lore-sync-validate.js";
import { readBestEffort, reindexTouchedFiles } from "./shared.js";
import type { PendingLoreSync, TurnDeps, TurnPlan } from "./types.js";

/**
 * 把本回合有 touched 的 NPC id，用小模型（characterClient，缺省退回主 client）
 * 各自讀取（已被整檔重寫過的）最新角色檔摘要成一句近況，同步進 characters/index.md 的「最近狀態」欄。
 * 不用主敘事模型：這只是省 context 的索引摘要，不需要主敘事的推理力。
 * 單筆摘要失敗只略過該筆，不中斷其他筆、不影響回合本身。
 */
async function syncCharacterIndexStatus(
  deps: TurnDeps,
  npcIds: string[],
  log: Logger,
): Promise<void> {
  const summaryClient = deps.characterClient ?? deps.client;
  const entries = await Promise.all(
    npcIds.map(async (id): Promise<readonly [string, string] | null> => {
      const characterMd = await readBestEffort(path.join(deps.worldDir, "characters", `${id}.md`));
      if (!characterMd) return null;
      const name = parseProtagonist(characterMd).name || id;
      const status = await summarizeNpcStatus({ name, characterMd, client: summaryClient });
      return status ? [id, status] : null;
    }),
  );
  const statusUpdates = Object.fromEntries(
    entries.filter((e): e is readonly [string, string] => e !== null),
  );
  if (Object.keys(statusUpdates).length === 0) return;

  const indexPath = path.join(deps.worldDir, "characters", "index.md");
  const indexMd = await readBestEffort(indexPath);
  if (!indexMd) return;
  await writeFile(indexPath, applyIndexStatusUpdates(indexMd, statusUpdates), "utf8");
  log.debug({ statusUpdates }, "同步 characters/index.md 近況欄");
}

/**
 * 把一個 Layer 3 任務包裝進 pendingLoreSync handle：保證 handle.promise 永遠 resolve
 * （任務內部已自行 catch，這裡只是雙重保險，避免下一回合開始時的 await 意外拋錯）。
 */
export function trackLoreSync(handle: PendingLoreSync, task: Promise<void>, log: Logger): void {
  handle.promise = task.catch((err) => {
    log.warn({ err }, "Layer 3 reactive-lore-sync 任務本身拋錯，已攔截，不影響下一回合");
  });
}

/**
 * Layer 3（reactive-lore-sync）：讀主腦敘事，抽出 npc/item/location/skill/wiki 的延後落地欄位。
 * 不卡玩家可見的 done event；任何步驟失敗只 log.warn，永遠不拋錯（保證 pendingLoreSync.promise 不 reject）。
 * 本回合若沒有任何 lore 異動則不 commit，避免空 commit。
 */
export async function runLoreSync(
  deps: TurnDeps,
  narrative: string,
  settingText: string,
  plan: TurnPlan,
  log: Logger,
): Promise<void> {
  try {
    const loreClient = deps.loreClient ?? deps.controlClient ?? deps.client;
    let raw = "";
    for await (const delta of loreClient.streamChat(plan.buildLoreSync(narrative))) {
      raw += delta;
    }
    const sync = parseLoreSyncOutput(raw);
    const changes = sync.state_changes;

    // A 校驗 gate（落地前、呼叫任何 LLM 重寫之前）：
    // 1) 剔除黑名單/非 slug/同回合跨 category 的垃圾 entity
    // 2) 與既有檔案 category 對齊（既有檔案是 canonical truth）
    // 這道 gate 同時抑制假 entity 暴增 LLM 重寫呼叫（根因 G 的呼叫量來源）。
    const sanitized = sanitizeTouchedEntities(changes.touched_entities ?? [], log);
    const [itemIds, locationIds, skillIds] = await Promise.all([
      listLoreIds(deps.worldDir, "items", log),
      listLoreIds(deps.worldDir, "locations", log),
      listLoreIds(deps.worldDir, "skills", log),
    ]);
    const indexMdForIds = await readBestEffort(path.join(deps.worldDir, "characters", "index.md"));
    const npcEntries = parseCharacterIndex(indexMdForIds);
    const npcNameToId = new Map(npcEntries.map((n) => [n.name.trim().toLowerCase(), n.id]));
    const entities = reconcileEntityCategories(
      sanitized,
      {
        npc: new Set(npcEntries.map((n) => n.id)),
        item: new Set(itemIds),
        location: new Set(locationIds),
        skill: new Set(skillIds),
      },
      log,
      npcNameToId,
    );

    // F：把「主角在不在副本」情境傳給知識庫維護者，避免把安全區事件誤寫成副本內
    const loreContext: LoreRewriteContext = { inDungeon: Boolean(plan.dungeonId), dungeonId: plan.dungeonId };
    const entityResults = await Promise.all(
      entities.map((e) => rewriteLoreEntity(deps, settingText, e, log, loreContext)),
    );

    let dungeonResult: LoreRewriteResult | null = null;
    if (changes.dungeon_wiki_excerpt && plan.dungeonId) {
      const rewriteClient = deps.loreClient ?? deps.controlClient ?? deps.client;
      const existing = await loadDungeonLore(deps.worldDir, plan.dungeonId, log);
      const title = `副本 ${plan.dungeonId} · 已揭露知識（Wiki）`;
      const content = await callLoreRewrite(
        rewriteClient,
        settingText,
        changes.dungeon_wiki_excerpt,
        title,
        existing.wiki,
        "dungeon",
        log,
        loreContext,
      );
      if (content) dungeonResult = { id: plan.dungeonId, category: "dungeon", title, content };
    }

    // protagonist 落地（Layer 權責重劃）：積分由引擎決定論先算，再整檔重寫整合成長。
    // delta 或 protagonist_changed 任一成立才動；兩者皆否完全跳過。
    const pointsDelta = changes.protagonist_points_delta ?? 0;
    const protagonistChanged = changes.protagonist_changed === true;
    let protagonistTouched = false;
    if (pointsDelta !== 0 || protagonistChanged) {
      const pPath = path.join(deps.worldDir, "characters", "protagonist.md");
      const before = await readBestEffort(pPath);
      if (before) {
        const withPoints = pointsDelta !== 0 ? applyPointsDelta(before, pointsDelta) : before;
        const rewritten = await callProtagonistRewrite(
          deps.loreClient ?? deps.controlClient ?? deps.client,
          settingText,
          narrative,
          withPoints,
          log,
          loreContext,
        );
        // 重寫成功用新版；失敗至少落地積分（withPoints），不丟分
        await writeFile(pPath, rewritten ?? withPoints, "utf8");
        protagonistTouched = true;
      } else {
        log.warn("protagonist.md 不存在，略過本回合主角落地");
      }
    }

    const results = [
      ...entityResults.filter((r): r is LoreRewriteResult => r !== null),
      ...(dungeonResult ? [dungeonResult] : []),
    ];

    const existingNpcIds: string[] = [];
    for (const r of results) {
      if (r.category === "npc") {
        const existed = Boolean(await readBestEffort(path.join(deps.worldDir, "characters", `${r.id}.md`)));
        await rewriteNpcFile(deps.worldDir, r.id, r.content, log);
        if (existed) {
          existingNpcIds.push(r.id);
        } else {
          const indexPath = path.join(deps.worldDir, "characters", "index.md");
          const indexMd = await readBestEffort(indexPath);
          if (indexMd) await writeFile(indexPath, addCharacterIndexRow(indexMd, r.id, r.title), "utf8");
        }
      } else {
        const category = r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category];
        await rewriteLoreWiki(deps.worldDir, category, r.id, r.content, r.title, log);
      }
    }

    // 全新建檔的 NPC 維持 addCharacterIndexRow 的預設「初次登場」，不額外摘要近況
    // （本回合剛建檔，立刻再摘要一次沒有額外價值，也避免多耗一次小模型呼叫）。
    const npcIds = results.filter((r) => r.category === "npc").map((r) => r.id);
    if (existingNpcIds.length > 0) await syncCharacterIndexStatus(deps, existingNpcIds, log);

    if (deps.recall) {
      const touched: string[] = results.map((r) =>
        r.category === "npc"
          ? path.join(deps.worldDir, "characters", `${r.id}.md`)
          : path.join(loreDir(deps.worldDir, r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category], r.id), "wiki.md"),
      );
      if (npcIds.length > 0) touched.push(path.join(deps.worldDir, "characters", "index.md"));
      if (protagonistTouched) touched.push(path.join(deps.worldDir, "characters", "protagonist.md"));
      if (touched.length > 0) await reindexTouchedFiles(deps.recall, deps.worldDir, touched, log);
    }

    // 副本公告登記：敘事中首次出現系統公告的副本代碼時寫入 dungeons-index.md
    const announcedDungeon = changes.announced_dungeon;
    if (announcedDungeon?.id) {
      await registerAnnouncedDungeon(deps.worldDir, announcedDungeon.id, announcedDungeon.display_name);
      log.info({ id: announcedDungeon.id, displayName: announcedDungeon.display_name }, "副本公告登記");
    }

    if (results.length > 0 || protagonistTouched || announcedDungeon?.id) {
      const committed = await deps.commit("補完關聯文件（主角/NPC/道具/場景/技能）");
      log.info({ committed }, "回合結束（Layer 3 reactive-lore-sync）");
    } else {
      log.debug("Layer 3 reactive-lore-sync 本回合無 lore 異動，跳過 commit");
    }
  } catch (err) {
    log.warn({ err }, "Layer 3 reactive-lore-sync 失敗，本回合 lore 文件可能未完整補上");
  }
}

/**
 * 回合結束後啟動 Layer 3（不 await，讓回合本身立即結束）；有 pendingLoreSync handle 時
 * 接力寫回 handle，下一回合開始前會等它；沒有 handle（如未接線的舊呼叫端）則同步 await，
 * 維持「回合即時落地」的舊保證。
 */
export function scheduleLoreSync(
  deps: TurnDeps,
  narrative: string,
  settingText: string,
  plan: TurnPlan,
  log: Logger,
): Promise<void> {
  const task = runLoreSync(deps, narrative, settingText, plan, log);
  if (deps.pendingLoreSync) {
    trackLoreSync(deps.pendingLoreSync, task, log);
    return Promise.resolve();
  }
  return task;
}
