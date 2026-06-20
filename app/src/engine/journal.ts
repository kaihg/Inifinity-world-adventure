import { appendFile, readFile, open, stat } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";

export interface JournalEntry {
  date: string; // YYYY-MM-DD
  title: string;
  body: string;
}

/**
 * 把一段回合記錄 append 到 world/journal.md（主空間 raw 層，append-only）。
 * 段落格式對齊既有慣例：## [YYYY-MM-DD] 標題。
 */
export async function appendJournal(worldDir: string, entry: JournalEntry): Promise<void> {
  const section = `\n## [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`;
  await appendFile(path.join(worldDir, "journal.md"), section, "utf8");
}

export interface LastTurnRecord {
  narrative: string;
  suggestedActions: string[];
}

const SUGGESTED_MARKER = "\n\n建議動作：";
const ROLLS_MARKER = "\n\n擲骰：";

/**
 * 還原最後一段回合記錄（給前端重開頁面時還原劇情）。
 * 對齊 turn.ts 寫入的 body 格式：玩家行動/骰池 前綴、敘事正文、可選的擲骰/建議動作後綴。
 * 通用於 journal.md 與 dungeons/<id>/runs/<run-id>.md（兩者段落格式相同）。
 */
export function parseLastTurnRecord(md: string): LastTurnRecord | null {
  const headers = [...md.matchAll(/^## \[.*?\] .*$/gm)];
  const last = headers.at(-1);
  if (!last || last.index === undefined) return null;

  let body = md.slice(last.index + last[0].length).trim();

  if (body.startsWith("玩家行動：")) {
    // 骰池行格式固定（骰池：[數字, 數字…]），用它定位前綴結尾，
    // 不可假設「玩家行動：」後的內容只佔一行（/api/turn 的 input 可能是多行文字）
    const diceMatch = body.match(/\n骰池：\[[0-9, ]*\]\n+/);
    body = diceMatch
      ? body.slice(diceMatch.index! + diceMatch[0].length)
      : body.replace(/^玩家行動：.*\n+/, ""); // 舊格式：沒有骰池行
  }

  // 建議動作以 JSON 陣列編碼，往返不受內容本身含特殊字元影響；
  // 找「最後一個」標記（而非第一個），避免敘事正文恰好出現同字樣時誤切；
  // JSON 解析失敗代表那只是巧合的文字，不裁切。
  let suggestedActions: string[] = [];
  const suggestedAt = body.lastIndexOf(SUGGESTED_MARKER);
  if (suggestedAt !== -1) {
    const raw = body.slice(suggestedAt + SUGGESTED_MARKER.length).trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
        suggestedActions = parsed;
        body = body.slice(0, suggestedAt).trimEnd();
      }
    } catch {
      // 非預期格式：視為敘事內文，不裁切
    }
  }

  const rollsAt = body.lastIndexOf(ROLLS_MARKER);
  if (rollsAt !== -1) body = body.slice(0, rollsAt).trimEnd();

  return { narrative: body, suggestedActions };
}

const TAIL_READ_BYTES = 64 * 1024;

async function readTail(file: string, fileSize: number, maxBytes: number): Promise<string> {
  const start = Math.max(0, fileSize - maxBytes);
  const fd = await open(file, "r");
  try {
    const length = fileSize - start;
    const buffer = Buffer.alloc(length);
    await fd.read(buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    await fd.close();
  }
}

/**
 * 讀檔案並還原最後一段回合記錄，只讀檔尾固定大小（預設 64KB），
 * 避免 append-only 的 journal.md／runs/*.md 隨遊戲進行增長後，每次 resume 都整檔重讀重解析。
 * 檔尾沒讀到任何段落標頭時（理論上只在單段內容異常龐大時發生）才退回整檔讀取。
 * 檔案不存在時回 null。
 */
export async function readLastTurnRecord(
  file: string,
  logger: Logger = defaultLogger,
): Promise<LastTurnRecord | null> {
  let fileStat;
  try {
    fileStat = await stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn({ err, file }, "讀取 raw 記錄檔案失敗（非檔案不存在）");
    }
    return null;
  }

  const tail = await readTail(file, fileStat.size, TAIL_READ_BYTES);
  const fromTail = parseLastTurnRecord(tail);
  if (fromTail || fileStat.size <= TAIL_READ_BYTES) return fromTail;

  const full = await readFile(file, "utf8");
  return parseLastTurnRecord(full);
}
