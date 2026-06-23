import { readJournalSummaryEntries } from "../journal-summary.js";
import { buildPacingMessages } from "./prompts.js";
import type { GameState } from "../context.js";
import type { TurnDeps, TurnEvent } from "./types.js";

const DEFAULT_REVIEW_INTERVAL = 10;
const PACING_HISTORY_TAIL = 50;

function formatPacingBlock(text: string): string {
  return ["## 節奏建議（長期，劇本大師）", text].join("\n");
}

/**
 * 長期節奏審閱：journal_summary.md 行數是 K 的倍數時，呼叫獨立 LLM 讀歷史摘要做節奏判斷；
 * 其餘回合直接回傳空字串，不呼叫 LLM。失敗時降級為空字串並 yield warning。
 */
export async function* runPacingBlock(
  deps: TurnDeps,
  state: GameState,
  settingText: string,
): AsyncGenerator<TurnEvent, string> {
  const interval = deps.pacingReviewInterval ?? DEFAULT_REVIEW_INTERVAL;
  try {
    const entries = await readJournalSummaryEntries(deps.worldDir);
    if (entries.length === 0 || entries.length % interval !== 0) return "";

    const tail = entries.slice(-PACING_HISTORY_TAIL);
    const client = deps.pacingClient ?? deps.controlClient ?? deps.client;
    const messages = buildPacingMessages({ settingText, state, entries: tail });

    let raw = "";
    for await (const delta of client.streamChat(messages)) raw += delta;
    const text = raw.trim();
    return text ? formatPacingBlock(text) : "";
  } catch (err) {
    yield { type: "warning" as const, message: `長期節奏審閱失敗，略過：${(err as Error).message}` };
    return "";
  }
}
