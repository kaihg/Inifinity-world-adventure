import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearRecallIndex } from "./clear-index.js";

describe("clearRecallIndex", () => {
  let indexDir: string;
  beforeEach(async () => {
    indexDir = await mkdtemp(path.join(tmpdir(), "iwa-recall-index-"));
    await writeFile(path.join(indexDir, "dummy.json"), "{}", "utf8");
  });
  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("enabled=true 時刪除整個 indexDir", async () => {
    await clearRecallIndex({ enabled: true, indexDir });
    await expect(access(indexDir)).rejects.toThrow();
  });

  it("enabled=false 時 no-op，不動 indexDir", async () => {
    await clearRecallIndex({ enabled: false, indexDir });
    await expect(access(indexDir)).resolves.not.toThrow();
  });

  it("indexDir 不存在時也不丟錯（force 行為）", async () => {
    await rm(indexDir, { recursive: true, force: true });
    await expect(clearRecallIndex({ enabled: true, indexDir })).resolves.not.toThrow();
  });
});
