import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { Logger } from "../../logger.js";
import type { RecallIndex } from "../../recall/store.js";
import type { FastControl } from "../schema.js";

/**
 * Layer 3（reactive-lore-sync）的接力 handle：一個 process 內的 mutable promise 容器，
 * 不是真正的 lock，只是讓「下一回合開始前」可以 await 上一回合的 lore-sync 是否落地完。
 * `promise` 永遠保證 resolve（內部已 catch），不會讓 await 端拋錯。
 */
export interface PendingLoreSync {
  promise: Promise<void> | null;
}

export interface TurnDeps {
  client: LlmClient;
  characterClient?: LlmClient;
  /** 結構控制抽取 LLM（副大腦）；未提供時退回 deps.client */
  controlClient?: LlmClient;
  /** Layer 3 reactive-lore-sync 用的 LLM；未提供時依序退回 controlClient、client */
  loreClient?: LlmClient;
  worldDir: string;
  commit: (message: string) => Promise<boolean>;
  today?: () => string;
  /** 本回合預擲骰池（測試可注入；預設 crypto 真隨機 6 顆 d100） */
  dicePool?: number[];
  /** 未提供時退回共用的預設 logger（測試環境下為 silent） */
  logger?: Logger;
  /** 語意檢索索引（選填；缺省時跳過檢索，不影響既有回合流程） */
  recall?: RecallIndex;
  /** 每回合檢索片段數上限，預設 5 */
  recallTopK?: number;
  /**
   * Layer 3 接力 handle（選填）。提供時，本回合的 lore-sync 不 await 完成即讓回合結束
   * （done event 立即送出），handle.promise 會被換成本回合的 lore-sync；
   * 未提供時退回舊行為：lore-sync 與回合本身同步完成。
   */
  pendingLoreSync?: PendingLoreSync;
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "warning"; message: string }
  | { type: "auto-advance"; index: number }
  | { type: "transition"; to: "dungeon" | "main-space"; dungeonId?: string }
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: FastControl["mode_transition"];
      transitionDungeonId?: string;
      transitionDungeonGoal?: string;
    };

/** 一回合所需的訊息建構器與落地設定，由 runMainSpaceTurn/runDungeonTurn 組裝後交給 runTurnCore/lore-sync 使用 */
export interface TurnPlan {
  /** 主腦（敘事）訊息 */
  messages: ChatMessage[];
  /** Layer 2（fast-control）訊息建構器：拿主腦完整敘事，回傳 fast-control 對話 */
  buildFastControl: (narrative: string) => ChatMessage[];
  /** Layer 3（reactive-lore-sync）訊息建構器：拿主腦完整敘事，回傳 lore-sync 對話 */
  buildLoreSync: (narrative: string) => ChatMessage[];
  /** raw 層落地：主空間→journal，副本→runs/<run>.md */
  appendRaw: (entry: { date: string; title: string; body: string }) => Promise<void>;
  /** raw 層檔案絕對路徑（journal.md 或 runs/<run>.md），供回合結束後重建語意索引用 */
  rawFilePath: string;
  /** 當前副本 id（僅副本回合有），供 Layer 3 落地 dungeon_wiki_excerpt 用 */
  dungeonId?: string;
}
