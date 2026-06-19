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
