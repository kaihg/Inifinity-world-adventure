import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../logger.js";
import {
  applyPointsDelta,
  applyProtagonistUpdates,
  loadState,
  type GameState,
} from "../context.js";
import { applyNowChanges, bumpNowUpdated, serializeNow } from "../now.js";
import { parseFastControlOutput, type FastControl } from "../schema.js";
import { appendJournalSummary } from "../journal-summary.js";
import { toTraditional } from "../text/traditionalize.js";
import { deriveSummary, nowISOSeconds, reindexTouchedFiles } from "./shared.js";
import type { TurnDeps, TurnEvent, TurnPlan } from "./types.js";

/**
 * 逐欄繁體化一個「欄位皆為 (可選) string 或 string[] 的扁平物件」。
 * 用 Object.keys 走訪而非硬編欄名：schema 之後新增欄位也會自動被涵蓋，
 * 不會悄悄漏轉（避免重新打開簡體雪球）。undefined 欄保持不存在。
 */
function traditionalizeStringBag<T extends Record<string, string | string[] | undefined>>(
  bag: T | undefined,
): T | undefined {
  if (!bag) return bag;
  const out: Record<string, string | string[] | undefined> = {};
  for (const key of Object.keys(bag)) {
    const v = bag[key];
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? v.map(toTraditional) : toTraditional(v);
  }
  return out as T;
}

/**
 * 把 Layer 2 抽出的「會落地進 world/ 的中文字串欄位」繁體化（決定論兜底）。
 * 不可變更新：回傳新物件，不動原 control。
 * 不轉 transition_dungeon_id（slug）與 transition_dungeon_goal（在 dungeon.ts 落地時轉，避免重複）。
 */
export function traditionalizeFastControl(control: FastControl): FastControl {
  const sc = control.state_changes;
  return {
    ...control,
    commit_summary: toTraditional(control.commit_summary),
    suggested_actions: control.suggested_actions.map(toTraditional),
    rolls: control.rolls.map((r) => ({ ...r, desc: toTraditional(r.desc) })),
    state_changes: {
      ...sc,
      now: traditionalizeStringBag(sc.now),
      protagonist_updates: traditionalizeStringBag(sc.protagonist_updates),
    },
  };
}

/**
 * Layer 2（fast-control）：done event 前必須就位的最小狀態（now/主角/骰值/轉場/建議動作）。
 * npc/item/location/skill/wiki 等可延後落地的欄位交給 runLoreSync（Layer 3），不在此處理。
 * 回傳本回合敘事全文，供呼叫端接著餵給 Layer 3。
 */
export async function* runTurnCore(
  deps: TurnDeps,
  input: string,
  state: GameState,
  dicePool: number[],
  today: string,
  plan: TurnPlan,
  log: Logger,
): AsyncGenerator<TurnEvent, string> {
  log.debug({ dicePool }, "回合開始");

  // 1) 主腦：串流純敘事，delta 直接轉發（不再做 sentinel 切分）
  let narrative = "";
  for await (const delta of deps.client.streamChat(plan.messages)) {
    narrative += delta;
    yield { type: "delta", text: delta };
  }
  // 落地與下游（raw log、deriveSummary、餵 Layer 2/3 的事實來源）全部以繁體為準：
  // 在源頭轉一次，從根斷掉「簡體寫進 canonical → 下回合餵回模型 → 沿用」的雪球。
  // 注意：玩家已看到的串流 delta 不重送，只保證落地內容為繁體。
  narrative = toTraditional(narrative.trim());

  // 2) Layer 2：讀完整敘事抽最小狀態子集；失敗則降級（敘事已落地、暫停等玩家）
  const controlClient = deps.controlClient ?? deps.client;
  let control: FastControl | null = null;
  let raw = "";
  try {
    for await (const delta of controlClient.streamChat(plan.buildFastControl(narrative))) {
      raw += delta;
    }
    // 落地進 now.md / protagonist.md / commit / journal_summary 前繁體化（slug 類欄位不轉）
    control = traditionalizeFastControl(parseFastControlOutput(raw));
  } catch (err) {
    log.error({ err, raw }, "Layer 2 fast-control 結構抽取失敗，本回合僅保留敘事並暫停");
    yield {
      type: "warning",
      message: `Layer 2 結構抽取失敗，本回合僅保留敘事並暫停：${(err as Error).message}`,
    };
  }

  if (control && control.rolls.length > 0) {
    log.debug({ rolls: control.rolls }, "本回合擲骰結果");
  }

  const summary = control?.commit_summary || deriveSummary(narrative);

  // 1. raw 層
  const rollsLine =
    control && control.rolls.length > 0
      ? `\n\n擲骰：${control.rolls.map((r) => `${r.desc}=${r.value}${r.success === undefined ? "" : r.success ? "(成功)" : "(失敗)"}`).join("、")}`
      : "";
  const suggestedActions = control?.suggested_actions ?? [];
  const suggestedLine = suggestedActions.length > 0 ? `\n\n建議動作：${suggestedActions.join("、")}` : "";
  await plan.appendRaw({
    date: today,
    title: summary,
    body: `玩家行動：${input}\n骰池：[${dicePool.join(", ")}]\n\n${narrative}${rollsLine}${suggestedLine}`,
  });

  // 1b. journal_summary 索引（衍生摘要，給短期/長期節奏機制讀；失敗只警告，不擋本回合落地）
  try {
    await appendJournalSummary(deps.worldDir, {
      timestamp: (deps.now ?? nowISOSeconds)(),
      mode: plan.dungeonId ? `副本:${plan.dungeonId}` : "主空間",
      summary,
    });
  } catch (err) {
    log.warn({ err }, "journal_summary.md 寫入失敗，略過（不影響本回合落地）");
  }

  // 2. 提煉頁 now.md
  const nowPath = path.join(deps.worldDir, "now.md");
  if (control) {
    // 進行中的副本欄由引擎依 mode_transition 管理（enterDungeon/setNowActiveDungeon），
    // 不接受 Layer 2 透過 now.activeDungeon 自行覆寫，避免繞過 run log/secrets 生成的正規流程。
    const { activeDungeon: _ignored, ...nowChanges } = control.state_changes.now ?? {};
    const newNow = applyNowChanges(state.now, nowChanges, { date: today, summary });
    await writeFile(nowPath, serializeNow(newNow), "utf8");
  } else {
    const nowMd = await readFile(nowPath, "utf8");
    await writeFile(nowPath, bumpNowUpdated(nowMd, { date: today, summary }), "utf8");
  }

  // 3. 主角狀態（積分 + 屬性/技能/物品/buff 新增項，否則主角的成長不會被記住）
  const delta = control?.state_changes.protagonist_points_delta ?? 0;
  const protagonistUpdates = control?.state_changes.protagonist_updates;
  if (delta || protagonistUpdates) {
    const pPath = path.join(deps.worldDir, "characters", "protagonist.md");
    let pMd = await readFile(pPath, "utf8");
    if (delta) pMd = applyPointsDelta(pMd, delta);
    if (protagonistUpdates) pMd = applyProtagonistUpdates(pMd, protagonistUpdates);
    await writeFile(pPath, pMd, "utf8");
  }

  // 4. 語意檢索索引：把本回合異動的檔案重新切塊嵌入（derived cache，與 git commit 內容無關）
  if (deps.recall) {
    const touched = [plan.rawFilePath];
    if (delta || protagonistUpdates) {
      touched.push(path.join(deps.worldDir, "characters", "protagonist.md"));
    }
    await reindexTouchedFiles(deps.recall, deps.worldDir, touched, log);
  }

  // 5. commit
  const committed = await deps.commit(summary);

  log.info(
    {
      committed,
      awaitingUserInput: control?.awaiting_user_input ?? true,
      modeTransition: control?.mode_transition ?? null,
    },
    "回合結束（Layer 2）",
  );

  // done 前讀一次當前狀態快照，內嵌進事件供前端面板即時更新。
  // 此刻 now.md / 主角檔已落地；Layer 3（NPC/wiki）尚未開始，故 NPC 可能仍是上一回合值（見 spec）。
  // loadState 失敗不可讓回合崩潰：省略 state、warn、回合照常結束。
  let stateSnapshot: GameState | undefined;
  try {
    stateSnapshot = await loadState(deps.worldDir, log);
  } catch (err) {
    log.warn({ err }, "done 前 loadState 失敗，本回合 done 不帶 state 快照");
  }

  yield {
    type: "done",
    narrative,
    committed,
    awaitingUserInput: control?.awaiting_user_input ?? true,
    suggestedActions,
    modeTransition: control?.mode_transition ?? null,
    transitionDungeonId: control?.transition_dungeon_id || undefined,
    transitionDungeonGoal: control?.transition_dungeon_goal || undefined,
    state: stateSnapshot,
  };

  return narrative;
}
