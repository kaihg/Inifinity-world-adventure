import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../logger.js";
import {
  loadState,
  parseNow,
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
    },
  };
}

/**
 * Layer 2（fast-control）：done event 前必須就位的最小狀態（now/主角/骰值/轉場/建議動作）。
 * npc/item/scene/skill/wiki 等可延後落地的欄位交給 runLoreSync（Layer 3），不在此處理。
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

  // 2) Layer 2：讀完整敘事抽最小狀態子集；失敗則重試（小模型偶發吐出非結構化輸出，
  // 重新取樣常能拿到合法 JSON），重試次數耗盡才真正降級（敘事已落地、暫停等玩家）。
  const controlClient = deps.controlClient ?? deps.client;
  const maxAttempts = (deps.controlMaxRetries ?? 2) + 1;
  let control: FastControl | null = null;
  let raw = "";
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    raw = "";
    try {
      for await (const delta of controlClient.streamChat(plan.buildFastControl(narrative))) {
        raw += delta;
      }
      // 落地進 now.md / protagonist.md / commit / journal_summary 前繁體化（slug 類欄位不轉）
      control = traditionalizeFastControl(parseFastControlOutput(raw));
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        log.warn({ err, raw, attempt }, "Layer 2 fast-control 解析失敗，準備重試");
      }
    }
  }
  if (!control) {
    log.error({ err: lastErr, raw }, "Layer 2 fast-control 結構抽取失敗（已重試），本回合僅保留敘事並暫停");
    yield {
      type: "warning",
      message: `Layer 2 結構抽取失敗，本回合僅保留敘事並暫停：${(lastErr as Error).message}`,
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

  // 4. 語意檢索索引：把本回合異動的 raw 檔重新切塊嵌入（protagonist 改由 Layer 3 重建）
  if (deps.recall) {
    await reindexTouchedFiles(deps.recall, deps.worldDir, [plan.rawFilePath], log);
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

  // 主角永久死亡：寫 sentinel、覆寫 now 下一步欄、強制暫停（不依賴模型自己回報 awaiting）
  const protagonistDied = control?.protagonist_permanent_death === true;
  if (protagonistDied) {
    await writeFile(path.join(deps.worldDir, ".pending-death"), new Date().toISOString(), "utf8");
    const nowMd2 = await readFile(nowPath, "utf8");
    const now2 = applyNowChanges(
      parseNow(nowMd2),
      { nextStep: "等待抉擇：保留世界換主角 / 結束世界" },
      { date: today, summary },
    );
    await writeFile(nowPath, serializeNow(now2), "utf8");
  }

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
    awaitingUserInput: protagonistDied ? true : (control?.awaiting_user_input ?? true),
    suggestedActions,
    modeTransition: control?.mode_transition ?? null,
    transitionDungeonId: control?.transition_dungeon_id || undefined,
    transitionDungeonGoal: control?.transition_dungeon_goal || undefined,
    protagonistDied,
    state: stateSnapshot,
  };

  return narrative;
}
