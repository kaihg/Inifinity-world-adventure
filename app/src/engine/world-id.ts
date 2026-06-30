import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 產生新世界的 UUID（v4） */
export function generateWorldUuid(): string {
  return randomUUID();
}

/** 把 world_uuid 寫入 worldDir/meta.json */
export async function writeWorldMeta(worldDir: string, worldUuid: string): Promise<void> {
  await writeFile(
    path.join(worldDir, "meta.json"),
    JSON.stringify({ worldUuid }) + "\n",
    "utf8",
  );
}

/**
 * 從 worldDir/meta.json 讀取並回傳 world_uuid。
 * 若找不到則拋出錯誤。
 */
export async function readWorldUuid(worldDir: string): Promise<string> {
  const content = await readFile(path.join(worldDir, "meta.json"), "utf8");
  const parsed = JSON.parse(content) as { worldUuid?: string };
  if (!parsed.worldUuid) throw new Error("meta.json 中找不到 worldUuid");
  return parsed.worldUuid;
}
