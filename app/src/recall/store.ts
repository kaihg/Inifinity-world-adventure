import { LocalIndex } from "vectra";
import { chunkMarkdown } from "./chunk.js";
import type { Embedder } from "./embedder.js";

export interface RecallHit {
  file: string;
  heading: string;
  text: string;
  score: number;
}

/** 引擎依賴的最小檢索介面，與底層用 vectra 或別的向量庫無關 */
export interface RecallIndex {
  query(text: string, topK: number): Promise<RecallHit[]>;
  upsertFile(relPath: string, content: string): Promise<void>;
  removeFile(relPath: string): Promise<void>;
}

interface ChunkMetadata extends Record<string, string> {
  file: string;
  heading: string;
  text: string;
}

/** 把 world/ 內 Markdown 檔案切塊嵌入存進本地向量索引（derived cache，可隨時刪除重建，不進 git） */
export class RecallStore implements RecallIndex {
  private readonly index: LocalIndex<ChunkMetadata>;
  private ready: Promise<void> | null = null;

  constructor(indexDir: string, private readonly embedder: Embedder) {
    this.index = new LocalIndex<ChunkMetadata>(indexDir);
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        if (!(await this.index.isIndexCreated())) {
          await this.index.createIndex();
        }
      })();
    }
    return this.ready;
  }

  /** 先刪除該檔案舊的 chunk 再重新切塊/嵌入插入，確保索引不留殘留段落 */
  async upsertFile(relPath: string, content: string): Promise<void> {
    await this.ensureReady();
    await this.removeFile(relPath);

    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) return;

    const vectors = await this.embedder.embed(chunks.map((c) => c.text));
    await this.index.batchInsertItems(
      chunks.map((chunk, i) => ({
        vector: vectors[i],
        metadata: { file: relPath, heading: chunk.heading, text: chunk.text },
      })),
    );
  }

  async removeFile(relPath: string): Promise<void> {
    await this.ensureReady();
    const stale = await this.index.listItemsByMetadata({ file: relPath });
    if (stale.length > 0) await this.index.deleteItems(stale.map((item) => item.id));
  }

  async query(text: string, topK: number): Promise<RecallHit[]> {
    await this.ensureReady();
    const [vector] = await this.embedder.embed([text]);
    const results = await this.index.queryItems<ChunkMetadata>(vector, text, topK);
    return results.map((r) => ({
      file: r.item.metadata.file,
      heading: r.item.metadata.heading,
      text: r.item.metadata.text,
      score: r.score,
    }));
  }
}
