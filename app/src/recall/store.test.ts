import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecallStore } from "./store.js";
import type { Embedder } from "./embedder.js";

/**
 * 決定論假嵌入：bag-of-characters 雜湊進固定維度向量（中文無空格分詞，
 * 用字元級重疊近似語意相似度），足以讓共享字詞的文字相似度較高。
 */
function createFakeEmbedder(dim = 64): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vec = new Array(dim).fill(0);
        for (const ch of Array.from(text).filter((c) => /[\p{L}\p{N}]/u.test(c))) {
          vec[ch.codePointAt(0)! % dim] += 1;
        }
        return vec;
      });
    },
  };
}

describe("RecallStore", () => {
  let indexDir: string;
  let store: RecallStore;

  beforeEach(async () => {
    indexDir = await mkdtemp(path.join(os.tmpdir(), "recall-store-test-"));
    store = new RecallStore(indexDir, createFakeEmbedder());
  });

  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("upsertFile 切塊存入後可被語意查詢命中", async () => {
    await store.upsertFile(
      "characters/foo.md",
      ["## 背景", "小明是個鐵匠", "## 近況", "小明最近在副本中受傷了"].join("\n"),
    );

    const hits = await store.query("受傷", 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: "characters/foo.md", heading: "近況" });
    expect(hits[0].text).toContain("受傷");
  });

  it("removeFile 後該檔案的 chunk 不再被查到", async () => {
    await store.upsertFile("characters/foo.md", "## 近況\n小明最近在副本中受傷了");
    await store.removeFile("characters/foo.md");

    const hits = await store.query("小明 受傷", 5);
    expect(hits).toHaveLength(0);
  });

  it("重複 upsertFile 同一檔案會先清掉舊 chunk，不留殘留段落", async () => {
    await store.upsertFile("characters/foo.md", "## 近況\n舊版內容：小明很健康");
    await store.upsertFile("characters/foo.md", "## 近況\n新版內容：小明受傷了");

    const hits = await store.query("小明", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("新版內容");
  });

  it("不同檔案互不影響，可同時查到", async () => {
    await store.upsertFile("characters/a.md", "## 設定\nA 是個法師");
    await store.upsertFile("characters/b.md", "## 設定\nB 是個戰士");

    const hits = await store.query("法師 戰士", 5);
    const files = hits.map((h) => h.file).sort();
    expect(files).toEqual(["characters/a.md", "characters/b.md"]);
  });
});
