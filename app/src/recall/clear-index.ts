import { rm } from "node:fs/promises";

/**
 * 刪除整個 .recall-index/ 目錄（derived cache，下次需要時 lazy 重建）。
 * 用於 world/init、world/end、主角換代後，避免舊世界的向量殘留污染新世界的檢索結果。
 *
 * 不依 recall 目前是否啟用判斷：索引可能是先前啟用時建的，之後即使
 * RECALL_ENABLED 關閉/未設，磁碟上的舊向量殘留仍要清掉，否則重新啟用
 * recall 時舊世界內容會混進新世界的語意檢索結果。
 */
export async function clearRecallIndex(indexDir: string): Promise<void> {
  await rm(indexDir, { recursive: true, force: true });
}
