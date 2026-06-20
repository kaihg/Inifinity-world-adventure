import type { EmbeddingsModel } from "vectra";

/** 嵌入模型抽象，方便測試注入 fake，避免單測依賴真實模型下載 */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

let cachedModel: Promise<EmbeddingsModel> | null = null;

/** 行程內單例：模型權重只在第一次真正呼叫 embed 時才透過 vectra 載入/下載 */
function getModel(): Promise<EmbeddingsModel> {
  if (!cachedModel) {
    cachedModel = (async () => {
      const { TransformersEmbeddings } = await import("vectra");
      return TransformersEmbeddings.create({ model: "Xenova/all-MiniLM-L6-v2" });
    })();
  }
  return cachedModel;
}

/**
 * 本地嵌入（Transformers.js，CPU 跑、無需金鑰）。
 * 首次呼叫 embed() 才會載入模型權重（若本機快取沒有，需要一次性網路下載）。
 */
export function createLocalEmbedder(): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const model = await getModel();
      const res = await model.createEmbeddings(texts);
      if (res.status !== "success" || !res.output) {
        throw new Error(`本地嵌入失敗：${res.message ?? res.status}`);
      }
      return res.output;
    },
  };
}
