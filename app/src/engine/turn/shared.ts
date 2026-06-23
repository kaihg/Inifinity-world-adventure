import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../logger.js";
import type { RecallIndex } from "../../recall/store.js";

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowISOSeconds(): string {
  return new Date().toISOString().slice(0, 19);
}

/** 自動推進迴圈用的系統 placeholder 輸入；短期停滯規則（nudge.ts）需要排除這個值，故搬到這裡共用，避免跟 index.ts 循環依賴 */
export const AUTO_CONTINUE_INPUT = "（系統自動推進：延續上一刻，繼續敘事，玩家未介入）";

export function deriveSummary(narrative: string): string {
  const firstLine = narrative.split("\n").find((l) => l.trim()) ?? "回合";
  const oneLine = firstLine.replace(/[#*>`]/g, "").trim();
  return oneLine.length > 40 ? oneLine.slice(0, 40) + "…" : oneLine;
}

export async function readBestEffort(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** 把本回合異動的檔案重新切塊嵌入進語意索引（derived cache，失敗只記警告，不影響回合落地） */
export async function reindexTouchedFiles(
  recall: RecallIndex,
  worldDir: string,
  absPaths: string[],
  log: Logger,
): Promise<void> {
  for (const absPath of absPaths) {
    const relPath = path.relative(worldDir, absPath);
    try {
      const content = await readFile(absPath, "utf8");
      await recall.upsertFile(relPath, content);
    } catch (err) {
      log.warn({ err, relPath }, "recall 索引更新失敗，略過");
    }
  }
}
