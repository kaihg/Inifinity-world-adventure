export interface NowUpdate {
  date: string; // YYYY-MM-DD
  summary: string;
}

const UPDATED_LINE = /^-\s*最後更新：.*$/m;

/**
 * 只覆寫 now.md 的「最後更新」行（lossless：不動其餘欄位與臨時欄位）。
 * Phase 2 的最小覆寫；完整的七欄結構化覆寫在 Phase 3。
 */
export function bumpNowUpdated(md: string, update: NowUpdate): string {
  const line = `- 最後更新：[${update.date}] ${update.summary}`;
  if (UPDATED_LINE.test(md)) {
    return md.replace(UPDATED_LINE, line);
  }
  const sep = md.endsWith("\n") ? "" : "\n";
  return `${md}${sep}${line}\n`;
}
