import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addCharacterIndexRow,
  applyIndexStatusUpdates,
  parseProtagonist,
  rewriteNpcFile,
} from "../context.js";
import { loadDungeonLore } from "../dungeon.js";
import type { Logger } from "../../logger.js";
import { loreFilePath, rewriteLoreFile } from "../lore.js";
import { extractJsonObject } from "../schema.js";
import { summarizeNpcStatus } from "../npc-status-summary.js";
import {
  ENTITY_CATEGORY_TO_LORE,
  callLoreRewrite,
  rewriteLoreEntity,
  type LoreEntityRef,
  type LoreRewriteContext,
  type LoreRewriteResult,
} from "./lore-rewrite.js";
import { TRADITIONAL_CHINESE_RULE } from "./prompts.js";
import { readBestEffort, reindexTouchedFiles } from "./shared.js";
import type { PendingLoreSync, TurnDeps, TurnPlan } from "./types.js";
import type { ChatMessage } from "../../llm/client.js";

// ---------------------------------------------------------------------------
// Layer 3 Local Schema（LoreSyncSchema は schema.ts から分離）
// protagonist_points_delta / protagonist_changed / announced_dungeon は Task 5-6 の
// 新 ingest アーキテクチャで再実装するため、ここからは除去。
// ---------------------------------------------------------------------------

const LoreEntityRefSchema = z.object({
  id: z.string(),
  category: z.enum(["npc", "item", "scene", "skill"]),
  name: z.string(),
  excerpt: z.string(),
});

const LoreStateChangesSchema = z
  .object({
    touched_entities: z.array(LoreEntityRefSchema).optional(),
    dungeon_wiki_excerpt: z.string().optional(),
  })
  .default({});

const LoreSyncSchema = z.object({
  state_changes: LoreStateChangesSchema,
});

export type LoreSync = z.infer<typeof LoreSyncSchema>;

/** Layer 3 原始輸出解析（rules 同 parseFastControlOutput） */
export function parseLoreSyncOutput(raw: string): LoreSync {
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    throw new Error("Layer 3 reactive-lore-sync 輸出找不到可解析的 JSON 物件");
  }
  return LoreSyncSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Layer 3 Local Message Builder（buildLoreSyncMessages は prompts.ts から分離）
// buildLoreSync は TurnPlan から除去されたため、runLoreSync 自身がメッセージを組む。
// ---------------------------------------------------------------------------

const LORE_SYNC_FORMAT_BLOCK = [
  "## 輸出格式（務必嚴格遵守）",
  `所有中文字串值一律使用繁體中文與台灣用詞（${TRADITIONAL_CHINESE_RULE}）。`,
  "只輸出**單一 JSON 物件**，不要任何前言、後語或程式碼框。欄位：",
  "- state_changes: { touched_entities?: [{id, category, name, excerpt}], dungeon_wiki_excerpt?: string }",
  "  - touched_entities：本回合敘事中明確登場、或知識被進一步揭露/訂正的 NPC、道具、場景、技能。",
  "    category 只能是 npc/item/scene/skill 其中之一；id 直接用中文顯示名稱（建議）或英文 slug；",
  "    **id 必須對應實體本身的名字**（例如「關公」「碰撞警報裝置」），不可用系統視角功能詞（system_monitor、handler）取代；" +
    "id 不可含 /、\\、.. 等路徑字元；name 用顯示名稱；",
  "    excerpt 是本回合敘事中跟這個實體有關的原文片段（之後會有另一步驟拿這段片段去跟現有檔案比較、",
  "    決定怎麼更新，你不需要自己組好最終的完整內容，只要把相關原文片段填進來）。",
  "  - dungeon_wiki_excerpt：劇情中對**當前副本本身**新揭露的知識片段（地圖/機關/規則），不在副本中則省略。",
  "（本回合若沒有任何相關異動，對應欄位省略即可，不要硬湊內容）",
].join("\n");

function buildLocalLoreSyncMessages(
  narrative: string,
  settingText: string,
  dungeonId?: string,
  wiki?: string,
): ChatMessage[] {
  const inDungeon = Boolean(dungeonId);
  const system = [
    "你是「無限恐怖」世界敘事引擎的**結構控制抽取器（Layer 3：reactive-lore-sync）**。",
    "下方有本回合已經產生的敘事散文，你的工作是把其中**已經發生的事實**整理成結構化 JSON，",
    "只需要負責 NPC 關係、道具/場景/技能的初次接觸與知識揭露，不需要處理 now/主角積分/轉場等即時狀態，那部分已由另一個抽取器處理。",
    "",
    "## 鐵則",
    "- 只整理敘事中已經寫出的事實，**不可新增劇情、不可發明敘事未提及的事件**。",
    "- touched_entities 的 excerpt 只填**敘事中明確公開揭露給主角知道**的真相（角色已親眼確認、已被明說）；" +
      "敘事中模糊的暗示、伏筆、氣氛描寫一律不可當成已揭露填入，寧可漏填也不可提前洩漏暗線。",
    "",
    LORE_SYNC_FORMAT_BLOCK,
    "",
    "## 世界設定",
    settingText.trim(),
    "",
    ...(inDungeon
      ? ["## 副本已揭露知識（wiki）", (wiki ?? "").trim() || "（尚無）", "", `## 當前副本 id：${dungeonId}`, ""]
      : []),
    "## 本回合敘事散文（事實來源）",
    narrative.trim(),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: "請依上述鐵則抽取本回合 lore 更動。" },
  ];
}

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
 * Layer 3（reactive-lore-sync）：讀主腦敘事，抽出 npc/item/scene/skill/wiki 的延後落地欄位。
 * 不卡玩家可見的 done event；任何步驟失敗只 log.warn，永遠不拋錯（保證 pendingLoreSync.promise 不 reject）。
 * 本回合若沒有任何 lore 異動則不 commit，避免空 commit。
 *
 * 注意：protagonist 落地（protagonist_points_delta / protagonist_changed）與
 * 副本公告（announced_dungeon）已於 Task 2 移除，將在 Task 5-6 的新 ingest 架構重實作。
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
    const wiki = plan.dungeonId ? (await loadDungeonLore(deps.worldDir, plan.dungeonId, log)).wiki : undefined;
    const messages = buildLocalLoreSyncMessages(narrative, settingText, plan.dungeonId, wiki);
    for await (const delta of loreClient.streamChat(messages)) {
      raw += delta;
    }
    const sync = parseLoreSyncOutput(raw);
    const changes = sync.state_changes;

    const entities = changes.touched_entities ?? [];

    // F：把「主角在不在副本」情境傳給知識庫維護者，避免把安全區事件誤寫成副本內
    const loreContext: LoreRewriteContext = { inDungeon: Boolean(plan.dungeonId), dungeonId: plan.dungeonId };
    const entityResults = await Promise.all(
      entities.map((e) => rewriteLoreEntity(deps, settingText, e as LoreEntityRef, log, loreContext)),
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
        await rewriteLoreFile(deps.worldDir, category, r.id, r.content, r.title, log);
      }
    }

    // 全新建檔的 NPC 維持 addCharacterIndexRow 的預設「初次登場」，不額外摘要近況
    const npcIds = results.filter((r) => r.category === "npc").map((r) => r.id);
    if (existingNpcIds.length > 0) await syncCharacterIndexStatus(deps, existingNpcIds, log);

    if (deps.recall) {
      const touched: string[] = results.map((r) =>
        r.category === "npc"
          ? path.join(deps.worldDir, "characters", `${r.id}.md`)
          : loreFilePath(deps.worldDir, r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category], r.id),
      );
      if (npcIds.length > 0) touched.push(path.join(deps.worldDir, "characters", "index.md"));
      if (touched.length > 0) await reindexTouchedFiles(deps.recall, deps.worldDir, touched, log);
    }

    if (results.length > 0) {
      const committed = await deps.commit("補完關聯文件（NPC/道具/場景/技能）");
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
