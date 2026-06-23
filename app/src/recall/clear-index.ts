import { rm } from "node:fs/promises";

/**
 * 若 recall 啟用，刪除整個 .recall-index/ 目錄（derived cache，下次需要時 lazy 重建）。
 * 用於 world/init、world/end、主角換代後，避免舊世界的向量殘留污染新世界的檢索結果。
 */
export async function clearRecallIndex(
  recallConfig: { enabled: boolean; indexDir: string },
): Promise<void> {
  if (!recallConfig.enabled) return;
  await rm(recallConfig.indexDir, { recursive: true, force: true });
}
