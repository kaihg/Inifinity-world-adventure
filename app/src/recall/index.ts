import { createLocalEmbedder } from "./embedder.js";
import { RecallStore, type RecallHit, type RecallIndex } from "./store.js";

export type { RecallHit, RecallIndex } from "./store.js";

/** 建一個以本地嵌入模型為底的 RecallIndex（模型/索引皆延遲初始化，建構本身是同步、零 I/O） */
export function createRecallIndex(indexDir: string): RecallIndex {
  return new RecallStore(indexDir, createLocalEmbedder());
}

/** 把檢索結果格式化為注入 system prompt 的區塊；無結果回空字串（不污染 prompt） */
export function formatRecallBlock(hits: RecallHit[]): string {
  if (hits.length === 0) return "";
  const lines = ["## 檢索到的相關記錄（按需參考，用來保持細節一致，不必逐字引用）"];
  for (const hit of hits) {
    const label = hit.heading ? `${hit.file} · ${hit.heading}` : hit.file;
    lines.push(`### ${label}`, hit.text.trim(), "");
  }
  return lines.join("\n").trimEnd();
}
