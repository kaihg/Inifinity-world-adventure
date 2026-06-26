import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** 產生新世界的 UUID（v4） */
export function generateWorldUuid(): string {
  return randomUUID();
}

/**
 * 把 world_uuid 注入 setting.md 的第二行（# 標題之後）。
 * 若已存在「世界 UUID：」行則原樣回傳（冪等）。
 */
export function injectWorldUuid(settingMd: string, worldUuid: string): string {
  if (/世界 UUID[:：]/.test(settingMd)) return settingMd;
  const lines = settingMd.trimEnd().split("\n");
  lines.splice(1, 0, "", `- 世界 UUID：${worldUuid}`);
  return `${lines.join("\n")}\n`;
}

/**
 * 從 worldDir/setting.md 讀取並回傳 world_uuid。
 * 若找不到則拋出錯誤。
 */
export async function readWorldUuid(worldDir: string): Promise<string> {
  const content = await readFile(path.join(worldDir, "setting.md"), "utf8");
  const match = content.match(/世界 UUID[:：]\s*([a-f0-9-]{36})/i);
  if (!match) throw new Error("setting.md 中找不到「世界 UUID：」行");
  return match[1];
}
