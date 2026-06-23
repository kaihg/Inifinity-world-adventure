import { readJournalSummaryEntries } from "../journal-summary.js";
import { createLocalEmbedder } from "../../recall/embedder.js";
import type { Embedder } from "../../recall/embedder.js";
import { AUTO_CONTINUE_INPUT } from "./shared.js";
import type { TurnDeps, TurnEvent } from "./types.js";

/** process-level singleton；deps.embedder 未提供時重用，避免每回合建立新閉包 */
const defaultEmbedder: Embedder = createLocalEmbedder();

/** 兩個等長向量的 cosine similarity；任一為零向量時回傳 0（避免除零）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function formatNudgeBlock(hint?: string): string {
  const base =
    "最近幾回合的劇情進展趨於重複，這回合請讓故事有實質推進（事件發生、衝突結果、新資訊揭露等）。";
  const hintLine = hint ? `（若有參考價值）玩家最近表達的方向：「${hint}」。` : "";
  return ["## 節奏建議（短期）", `${base}${hintLine}`].join("\n");
}

/**
 * 短期停滯規則：讀 world/journal_summary.md 最後 N 筆，用本地嵌入比較相鄰兩筆的 cosine
 * similarity；全部相鄰對都連續高度重複（≥ 門檻）時回傳格式化建議文字。
 * 不維護任何 in-memory 狀態——每回合都是現讀現查，天然跨重啟存活。
 * 失敗時降級為空字串並 yield warning，絕不拋出例外影響主回合管線。
 */
export async function* runNudgeBlock(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent, string> {
  // 設定值來自 config.ts DEFAULTS（透過 server/app.ts 注入），local fallback 僅為無注入的測試環境保底
  const windowSize = deps.nudgeWindowSize ?? 5;
  const threshold = deps.nudgeSimilarityThreshold ?? 0.92;
  try {
    const entries = await readJournalSummaryEntries(deps.worldDir);
    // windowSize < 2 時相鄰對為零，空真值下任意條目都會觸發；要求至少 2 筆才有意義的相鄰比較
    if (entries.length < windowSize || windowSize < 2) return "";

    const recentEntries = entries.slice(-windowSize);
    const embedder = deps.embedder ?? defaultEmbedder;
    const vectors = await embedder.embed(recentEntries.map((e) => e.summary));

    for (let i = 0; i < vectors.length - 1; i++) {
      if (cosineSimilarity(vectors[i], vectors[i + 1]) < threshold) return "";
    }

    const hint = input === AUTO_CONTINUE_INPUT ? undefined : input;
    return formatNudgeBlock(hint);
  } catch (err) {
    yield { type: "warning" as const, message: `短期停滯規則執行失敗，略過：${(err as Error).message}` };
    return "";
  }
}
