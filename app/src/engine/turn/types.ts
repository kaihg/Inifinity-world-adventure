import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { Logger } from "../../logger.js";
import type { RecallIndex } from "../../recall/store.js";
import type { Embedder } from "../../recall/embedder.js";
import type { FastControl } from "../schema.js";
import type { GameState } from "../context.js";

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
  /** Layer 2 fast-control 解析失敗時的最多重試次數（不含原始呼叫），預設 2（共 3 次嘗試） */
  controlMaxRetries?: number;
  /** Layer 3 reactive-lore-sync 用的 LLM；未提供時依序退回 controlClient、client */
  loreClient?: LlmClient;
  /** 長期節奏審閱（劇本大師）用的 LLM（選填）；未提供時依序退回 controlClient、主 client */
  pacingClient?: LlmClient;
  /** 長期節奏審閱頻率：每 K 回合跑一次（K = journal_summary.md 行數的倍數），預設 10 */
  pacingReviewInterval?: number;
  worldDir: string;
  commit: (message: string) => Promise<boolean>;
  today?: () => string;
  /** journal_summary.md 寫入用的時間戳（測試可注入固定值）；未提供時退回真實 nowISOSeconds() */
  now?: () => string;
  /** 本回合預擲骰池（測試可注入；預設 crypto 真隨機 6 顆 d100） */
  dicePool?: number[];
  /** 未提供時退回共用的預設 logger（測試環境下為 silent） */
  logger?: Logger;
  /** 語意檢索索引（選填；缺省時跳過檢索，不影響既有回合流程） */
  recall?: RecallIndex;
  /** 每回合檢索片段數上限，預設 5 */
  recallTopK?: number;
  /** 短期停滯規則用的本地嵌入器（選填；測試可注入 fake，預設 createLocalEmbedder()） */
  embedder?: Embedder;
  /** 短期停滯規則比較的視窗大小（最近 N 筆 journal_summary 條目），預設 5 */
  nudgeWindowSize?: number;
  /** 短期停滯規則的 cosine similarity 命中門檻（0~1），預設 0.92 */
  nudgeSimilarityThreshold?: number;
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
      /** 主角永久死亡（新手保護耗盡）；true 時前端顯示死亡抉擇 modal */
      protagonistDied: boolean;
      /** 本回合 Layer 2 落地後的當前狀態快照，供前端面板即時更新；loadState 失敗時省略 */
      state?: GameState;
    };

/** 一回合所需的訊息建構器與落地設定，由 runMainSpaceTurn/runDungeonTurn 組裝後交給 runTurnCore/lore-sync 使用 */
export interface TurnPlan {
  /** 主腦（敘事）訊息 */
  messages: ChatMessage[];
  /** Layer 2（fast-control）訊息建構器：拿主腦完整敘事，回傳 fast-control 對話 */
  buildFastControl: (narrative: string) => ChatMessage[];
  /** raw 層落地：主空間→journal，副本→runs/<run>.md */
  appendRaw: (entry: { date: string; title: string; body: string }) => Promise<void>;
  /** raw 層檔案絕對路徑（journal.md 或 runs/<run>.md），供回合結束後重建語意索引用 */
  rawFilePath: string;
  /** 當前副本 id（僅副本回合有），供 Layer 3 落地 dungeon_wiki_excerpt 用 */
  dungeonId?: string;
}
