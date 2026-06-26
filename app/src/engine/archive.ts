import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

/** UTC 日期時間格式，可排序、人類可讀：2026-06-23_14-30-00 */
export function archiveTimestamp(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-06-23T14:30:05.123Z
  const [date, time] = iso.split("T");
  return `${date}_${time.slice(0, 8).replace(/:/g, "-")}`;
}

/**
 * 把 worldDir 整個目錄複製到 archives/<archiveTimestamp()>-<worldUuid>/world/。
 * 回傳封存目錄相對於 repoRoot 的路徑（例如 "archives/2026-06-23_14-30-00-<uuid>"）。
 */
export async function archiveWorld(
  repoRoot: string,
  worldDir: string,
  worldUuid: string,
  now: Date = new Date(),
): Promise<string> {
  const relArchiveDir = path.join("archives", `${archiveTimestamp(now)}-${worldUuid}`);
  const dest = path.join(repoRoot, relArchiveDir, "world");
  await mkdir(dest, { recursive: true });
  await cp(worldDir, dest, { recursive: true, force: true });
  return relArchiveDir;
}

/**
 * 只把指定的相對路徑清單複製到 archives/<archiveTimestamp()>/world/，保留原始子目錄結構。
 * 用於主角換代時只封存部分檔案（protagonist.md/index.md/journal.md/now.md），
 * 不像 archiveWorld 整個目錄複製。
 */
export async function archiveWorldFiles(
  repoRoot: string,
  worldDir: string,
  relativePaths: string[],
  now: Date = new Date(),
): Promise<string> {
  const relArchiveDir = path.join("archives", archiveTimestamp(now));
  for (const rel of relativePaths) {
    const dest = path.join(repoRoot, relArchiveDir, "world", rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(worldDir, rel), dest, { force: true });
  }
  return relArchiveDir;
}
