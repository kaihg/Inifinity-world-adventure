import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

export interface JournalSummaryEntry {
  timestamp: string;
  mode: string;
  summary: string;
}

const LINE_RE = /^- \[(.+?)\] \((.+?)\) (.*)$/;

/** 把一筆回合摘要 append 到 world/journal_summary.md（跨主空間/副本統一時間線，append-only）。 */
export async function appendJournalSummary(worldDir: string, entry: JournalSummaryEntry): Promise<void> {
  const line = `- [${entry.timestamp}] (${entry.mode}) ${entry.summary}\n`;
  await appendFile(path.join(worldDir, "journal_summary.md"), line, "utf8");
}

/**
 * 讀出 journal_summary.md 所有已解析的條目；檔案不存在時回傳空陣列。
 * 格式不符（損毀行、不完整的最後一行）的行靜默跳過，不影響其他條目。
 */
export async function readJournalSummaryEntries(worldDir: string): Promise<JournalSummaryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(worldDir, "journal_summary.md"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return [];
  }
  const entries: JournalSummaryEntry[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(LINE_RE);
    if (m) entries.push({ timestamp: m[1], mode: m[2], summary: m[3] });
  }
  return entries;
}
