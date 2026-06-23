import path from "node:path";
import { logger as defaultLogger } from "../../logger.js";
import { loadState } from "../context.js";
import {
  appendRun,
  enterDungeon,
  formatActiveDungeon,
  listDungeonIds,
  loadDungeonLore,
  parseActiveDungeon,
} from "../dungeon.js";
import { appendJournal } from "../journal.js";
import { rollPool } from "../roll.js";
import { runPrePassBlock, runRecallBlock } from "./context-blocks.js";
import { generateSecrets, setNowActiveDungeon } from "./dungeon-transition.js";
import { scheduleLoreSync } from "./lore-sync.js";
import {
  buildDungeonMessages,
  buildFastControlMessages,
  buildLoreSyncMessages,
  buildMainSpaceMessages,
} from "./prompts.js";
import { AUTO_CONTINUE_INPUT, readBestEffort, todayISO } from "./shared.js";
import { runTurnCore } from "./turn-core.js";
import type { TurnDeps, TurnEvent, TurnPlan } from "./types.js";

export type { PendingLoreSync, TurnDeps, TurnEvent } from "./types.js";

/** 主空間敘事回合 */
export async function* runMainSpaceTurn(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent> {
  const log = (deps.logger ?? defaultLogger).child({ mode: "main-space" });
  await deps.pendingLoreSync?.promise;

  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir, log);
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));

  const intentsBlock = yield* runPrePassBlock(deps, state, input);
  const recallBlock = yield* runRecallBlock(deps, input);

  const existingDungeonIds = await listDungeonIds(deps.worldDir, log);

  const plan: TurnPlan = {
    messages: buildMainSpaceMessages({ settingText, state, input, dicePool, intentsBlock, recallBlock }),
    buildFastControl: (narrative) =>
      buildFastControlMessages({ settingText, state, input, narrative, dicePool, existingDungeonIds }),
    buildLoreSync: (narrative) =>
      buildLoreSyncMessages({ settingText, state, input, narrative, dicePool, existingDungeonIds }),
    appendRaw: (entry) => appendJournal(deps.worldDir, entry),
    rawFilePath: path.join(deps.worldDir, "journal.md"),
  };

  const narrative = yield* runTurnCore(deps, input, state, dicePool, today, plan, log);
  await scheduleLoreSync(deps, narrative, settingText, plan, log);
}

/** 副本敘事回合（讀當前 now.md 的進行中副本，落地到 runs/*.md、提煉 wiki） */
export async function* runDungeonTurn(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent> {
  const baseLog = deps.logger ?? defaultLogger;
  await deps.pendingLoreSync?.promise;

  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir, baseLog);
  const active = parseActiveDungeon(state.now.activeDungeon);
  if (!active) {
    // 不在副本中卻被呼叫 → 退回主空間回合
    yield* runMainSpaceTurn(deps, input);
    return;
  }
  const log = baseLog.child({ mode: "dungeon", dungeonId: active.dungeonId, runId: active.runId });
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));
  const lore = await loadDungeonLore(deps.worldDir, active.dungeonId, log);

  const intentsBlock = yield* runPrePassBlock(deps, state, input);
  const recallBlock = yield* runRecallBlock(deps, input);

  const plan: TurnPlan = {
    messages: buildDungeonMessages({
      settingText, state, input, dicePool,
      dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      intentsBlock, recallBlock,
    }),
    buildFastControl: (narrative) =>
      buildFastControlMessages({
        settingText, state, input, narrative, dicePool,
        dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      }),
    buildLoreSync: (narrative) =>
      buildLoreSyncMessages({
        settingText, state, input, narrative, dicePool,
        dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      }),
    appendRaw: (entry) => appendRun(deps.worldDir, active.dungeonId, active.runId, entry),
    rawFilePath: path.join(deps.worldDir, "dungeons", active.dungeonId, "runs", `${active.runId}.md`),
    dungeonId: active.dungeonId,
  };

  const narrative = yield* runTurnCore(deps, input, state, dicePool, today, plan, log);
  await scheduleLoreSync(deps, narrative, settingText, plan, log);
}

/**
 * Mode-aware 自動推進迴圈：依 now.md 模式 dispatch 主空間/副本回合；
 * awaiting_user_input=false 時自動接續；mode_transition 觸發進/結算副本（不切 branch）。
 */
export async function* runTurnLoop(
  deps: TurnDeps,
  input: string,
  maxAuto: number,
): AsyncGenerator<TurnEvent> {
  const log = deps.logger ?? defaultLogger;
  const today = (deps.today ?? todayISO)();
  let currentInput = input;

  for (let i = 0; i <= maxAuto; i++) {
    const state = await loadState(deps.worldDir, log);
    const gen = state.mode === "dungeon" ? runDungeonTurn(deps, currentInput) : runMainSpaceTurn(deps, currentInput);

    let done: Extract<TurnEvent, { type: "done" }> | null = null;
    for await (const ev of gen) {
      yield ev;
      if (ev.type === "done") done = ev;
    }
    currentInput = AUTO_CONTINUE_INPUT;
    if (!done) break;

    // enter_dungeon 但副大腦沒給 transition_dungeon_id：無法建副本，不可靜默吞掉
    if (done.modeTransition === "enter_dungeon" && !done.transitionDungeonId) {
      log.warn("mode_transition=enter_dungeon 但缺 transition_dungeon_id，無法進入副本，停在主空間等玩家");
      yield {
        type: "warning",
        message: "系統判定要進入副本，但未能確定副本 id，暫停等玩家確認。",
      };
      break;
    }

    // 進入副本：生成 secrets、建 run、設 now，再自動接續第一個副本回合
    if (done.modeTransition === "enter_dungeon" && done.transitionDungeonId) {
      log.info({ dungeonId: done.transitionDungeonId }, "觸發 mode_transition：enter_dungeon");
      // 即將自行 commit；先等本回合的 Layer 3 落地完，避免兩個 git commit 並發搶鎖
      await deps.pendingLoreSync?.promise;
      const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));
      const secretsText = await generateSecrets(deps.client, settingText, done.transitionDungeonId);
      const active = await enterDungeon(
        deps.worldDir,
        {
          dungeonId: done.transitionDungeonId,
          today,
          protagonistSummary: `${state.protagonist.name}（積分 ${state.protagonist.points}）`,
          goal: done.transitionDungeonGoal?.trim() || "（待劇情揭露）",
          secretsText,
        },
        log,
      );
      await setNowActiveDungeon(deps.worldDir, formatActiveDungeon(active), {
        date: today,
        summary: `進入副本 ${active.dungeonId}`,
      });
      await deps.commit(`進入副本 ${active.dungeonId} ${active.runId}`);
      yield { type: "transition", to: "dungeon", dungeonId: active.dungeonId };
      if (i === maxAuto) break;
      yield { type: "auto-advance", index: i + 1 };
      continue;
    }

    // 結算副本：清空進行中副本欄，回主空間，交還玩家
    if (done.modeTransition === "settle_dungeon") {
      log.info({ dungeonId: state.now.activeDungeon }, "觸發 mode_transition：settle_dungeon");
      // 即將自行 commit；先等本回合的 Layer 3 落地完，避免兩個 git commit 並發搶鎖
      await deps.pendingLoreSync?.promise;
      await setNowActiveDungeon(deps.worldDir, "無", { date: today, summary: "副本結算，返回安全區" });
      await deps.commit("副本結算，返回安全區");
      yield { type: "transition", to: "main-space" };
      break;
    }

    if (done.awaitingUserInput) break;
    if (i === maxAuto) break;
    log.debug({ index: i + 1 }, "自動推進到下一回合");
    yield { type: "auto-advance", index: i + 1 };
  }
}
