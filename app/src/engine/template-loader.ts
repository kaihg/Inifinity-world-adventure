// app/src/engine/template-loader.ts
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 查找指定類型的 template 骨架。
 * 優先讀 world/templates/<type>.md（世界特定），
 * 缺檔退回 templates/<type>.md（全域骨架）。
 * 兩份都不存在則拋出 Error。
 */
export async function getTemplate(
  type: string,
  worldDir: string,
  repoRoot: string,
): Promise<string> {
  const worldSpecific = path.join(worldDir, "templates", `${type}.md`);
  const global = path.join(repoRoot, "templates", `${type}.md`);

  for (const file of [worldSpecific, global]) {
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`找不到 ${type} 的 template：已尋找 ${worldSpecific} 與 ${global}`);
}
