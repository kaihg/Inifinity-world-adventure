import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMarkdownFiles } from "./list-markdown-files.js";

describe("listMarkdownFiles", () => {
  let worldDir: string;

  beforeEach(async () => {
    worldDir = await mkdtemp(path.join(os.tmpdir(), "list-markdown-files-test-"));
  });

  afterEach(async () => {
    await rm(worldDir, { recursive: true, force: true });
  });

  it("遞迴找出所有 .md 檔案，回傳相對於 worldDir 的路徑並排序", async () => {
    await writeFile(path.join(worldDir, "setting.md"), "# setting");
    await mkdir(path.join(worldDir, "characters"));
    await writeFile(path.join(worldDir, "characters", "protagonist.md"), "# protagonist");
    await writeFile(path.join(worldDir, "characters", "index.md"), "# index");

    const files = await listMarkdownFiles(worldDir);

    expect(files).toEqual(["characters/index.md", "characters/protagonist.md", "setting.md"]);
  });

  it("忽略非 .md 檔案", async () => {
    await writeFile(path.join(worldDir, "setting.md"), "# setting");
    await writeFile(path.join(worldDir, "README.txt"), "not markdown");

    const files = await listMarkdownFiles(worldDir);

    expect(files).toEqual(["setting.md"]);
  });

  it("空目錄回傳空陣列", async () => {
    const files = await listMarkdownFiles(worldDir);
    expect(files).toEqual([]);
  });
});
