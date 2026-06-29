import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";

export type LoreCategory = "dungeons" | "items" | "skills" | "scenes";

/** 檔案不存在（ENOENT）是預期狀況；其他 I/O 錯誤才值得記錄 */
function logUnexpectedReadError(logger: Logger, file: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
  logger.warn({ err, file }, "讀取 lore 檔案失敗（非檔案不存在）");
}

/** 扁平路徑：world/<category>/<id>.md */
export function loreFilePath(worldDir: string, category: LoreCategory, id: string): string {
  return path.join(worldDir, category, `${id}.md`);
}

/** 讀單一 entity .md；ENOENT 回 "" */
export async function loadLoreFile(
  worldDir: string,
  category: LoreCategory,
  id: string,
  logger: Logger = defaultLogger,
): Promise<string> {
  const file = loreFilePath(worldDir, category, id);
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    logUnexpectedReadError(logger, file, err);
    return "";
  }
}

/** 整檔覆寫 entity .md；自動補 H1（僅在開頭缺 `# ` 時） */
export async function rewriteLoreFile(
  worldDir: string,
  category: LoreCategory,
  id: string,
  content: string,
  title: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  logger.debug({ category, id }, "整檔重寫 entity .md");
  const file = loreFilePath(worldDir, category, id);
  await mkdir(path.dirname(file), { recursive: true });
  const body = content.trim();
  const finalContent = /^#\s/.test(body) ? `${body}\n` : `# ${title}\n\n${body}\n`;
  await writeFile(file, finalContent, "utf8");
}

/** 列某分類下所有 entity id（.md 檔名去副檔名）；目錄不存在回 [] */
export async function listLoreIds(
  worldDir: string,
  category: LoreCategory,
  logger: Logger = defaultLogger,
): Promise<string[]> {
  const dir = path.join(worldDir, category);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "wiki.md")
      .map((e) => e.name.slice(0, -3));
  } catch (err) {
    logUnexpectedReadError(logger, dir, err);
    return [];
  }
}
