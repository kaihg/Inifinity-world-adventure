import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * 遞迴列出 worldDir 底下所有 .md 檔案，回傳相對於 worldDir 的相對路徑（已排序）。
 * 依賴 Node >=20.12 的 Dirent.parentPath（見 app/package.json engines）。
 */
export async function listMarkdownFiles(worldDir: string): Promise<string[]> {
  const entries = await readdir(worldDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.relative(worldDir, path.join(entry.parentPath, entry.name)))
    .sort();
}
