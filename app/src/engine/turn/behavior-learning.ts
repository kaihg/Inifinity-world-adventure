import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../logger.js";
import type { GameState } from "../context.js";
import { readBestEffort, reindexTouchedFiles } from "./shared.js";
import type { TurnDeps } from "./types.js";
import { buildBehaviorLearningMessages } from "./prompts.js";

const BEHAVIOR_FILE = path.join("characters", "protagonist-behavior.md");

type BehaviorState = Pick<GameState, "now" | "protagonist" | "protagonistDetail" | "npcs" | "mode" | "lastTurn">;

/**
 * 主角行為學習層：依本回合玩家行動與敘事，更新 protagonist-behavior.md。
 * 只記錄長期偏好，不改寫人格本體；失敗或無實質變更時靜默略過。
 */
export async function runBehaviorLearning(
  deps: TurnDeps,
  settingText: string,
  state: BehaviorState,
  input: string,
  narrative: string,
  log: Logger,
): Promise<void> {
  try {
    const behaviorClient = deps.characterClient ?? deps.controlClient ?? deps.client;
    const filePath = path.join(deps.worldDir, BEHAVIOR_FILE);
    const existing = await readBestEffort(filePath);

    const messages = buildBehaviorLearningMessages({
      settingText,
      state,
      input,
      narrative,
      dicePool: [],
      behaviorBlock: existing,
    });

    let raw = "";
    try {
      for await (const delta of behaviorClient.streamChat(messages)) raw += delta;
    } catch (err) {
      log.warn({ err }, "Layer 4 behavior-learning LLM 呼叫失敗，略過該筆");
      return;
    }

    const content = raw.trim();
    if (!content || content === existing.trim()) {
      log.debug("Layer 4 behavior-learning 本回合無明顯變更，跳過 commit");
      return;
    }

    await writeFile(filePath, `${content}\n`, "utf8");
    if (deps.recall) {
      await reindexTouchedFiles(deps.recall, deps.worldDir, [filePath], log);
    }
    const committed = await deps.commit("更新主角行為傾向");
    log.info({ committed }, "回合結束（Layer 4 behavior-learning）");
  } catch (err) {
    log.warn({ err }, "Layer 4 behavior-learning 失敗，本回合行為檔可能未更新");
  }
}

/**
 * 回合結束後啟動主角行為學習：若有 pending handle，就接在既有 post-turn promise 後面；
 * 沒有 pending handle 時則同步執行，維持舊版「回合後處理會等到完成」的行為。
 */
export function scheduleBehaviorLearning(
  deps: TurnDeps,
  settingText: string,
  state: BehaviorState,
  input: string,
  narrative: string,
  log: Logger,
): Promise<void> {
  if (deps.pendingLoreSync) {
    deps.pendingLoreSync.promise = Promise.resolve(deps.pendingLoreSync.promise).then(() =>
      runBehaviorLearning(deps, settingText, state, input, narrative, log),
    );
    return Promise.resolve();
  }
  return runBehaviorLearning(deps, settingText, state, input, narrative, log);
}
