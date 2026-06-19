import { appendFile } from "node:fs/promises";
import path from "node:path";

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
  // 骰池行是較新版本才有的欄位，舊記錄可能沒有；都當可選處理
  body = body.replace(/^玩家行動：.*\n(骰池：.*\n)?\n*/, "");

  let suggestedActions: string[] = [];
  const suggestedMatch = body.match(/\n\n建議動作：(.*)$/s);
  if (suggestedMatch) {
    suggestedActions = suggestedMatch[1]
      .split("、")
      .map((s) => s.trim())
      .filter(Boolean);
    body = body.slice(0, suggestedMatch.index).trimEnd();
  }

  body = body.replace(/\n\n擲骰：.*$/s, "").trimEnd();
  return { narrative: body, suggestedActions };
}
