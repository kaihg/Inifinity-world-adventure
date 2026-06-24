import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveTimestamp, archiveWorld, archiveWorldFiles } from "./archive.js";

describe("archiveTimestamp", () => {
  it("格式為 YYYY-MM-DD_HH-mm-ss（UTC，可字串排序）", () => {
    const ts = archiveTimestamp(new Date("2026-06-23T14:30:05.123Z"));
    expect(ts).toBe("2026-06-23_14-30-05");
  });
});

describe("archiveWorld / archiveWorldFiles", () => {
  let repoRoot: string;
  let worldDir: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-archive-repo-"));
    worldDir = path.join(repoRoot, "world");
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    await writeFile(path.join(worldDir, "setting.md"), "# 設定\n", "utf8");
    await writeFile(path.join(worldDir, "now.md"), "- 當前篇章：x\n", "utf8");
    await writeFile(path.join(worldDir, "journal.md"), "# 日誌\n", "utf8");
    await writeFile(path.join(worldDir, "characters", "protagonist.md"), "- 姓名：沈奕\n", "utf8");
    await writeFile(path.join(worldDir, "characters", "index.md"), "| ID |\n", "utf8");
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("archiveWorld 把整個 worldDir 複製到 archives/<ts>/world/，回傳相對路徑", async () => {
    const fixedNow = new Date("2026-06-23T14:30:05.000Z");
    const rel = await archiveWorld(repoRoot, worldDir, fixedNow);
    expect(rel).toBe("archives/2026-06-23_14-30-05");
    const settingCopy = await readFile(
      path.join(repoRoot, rel, "world", "setting.md"),
      "utf8",
    );
    expect(settingCopy).toBe("# 設定\n");
    const protagonistCopy = await readFile(
      path.join(repoRoot, rel, "world", "characters", "protagonist.md"),
      "utf8",
    );
    expect(protagonistCopy).toBe("- 姓名：沈奕\n");
  });

  it("archiveWorldFiles 只複製指定的相對路徑清單，保留子目錄結構", async () => {
    const fixedNow = new Date("2026-06-23T15:00:00.000Z");
    const rel = await archiveWorldFiles(
      repoRoot,
      worldDir,
      ["characters/protagonist.md", "characters/index.md", "journal.md", "now.md"],
      fixedNow,
    );
    expect(rel).toBe("archives/2026-06-23_15-00-00");
    const protagonistCopy = await readFile(
      path.join(repoRoot, rel, "world", "characters", "protagonist.md"),
      "utf8",
    );
    expect(protagonistCopy).toBe("- 姓名：沈奕\n");
    // setting.md 不在清單內，不該被複製
    await expect(
      access(path.join(repoRoot, rel, "world", "setting.md")),
    ).rejects.toThrow();
  });
});
