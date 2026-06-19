import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendJournal } from "./journal.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "iwa-journal-"));
  await writeFile(path.join(dir, "journal.md"), "# 主空間日誌\n\n## [2026-06-18] 既有段\n\n舊內容\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appendJournal", () => {
  it("以時間戳標題段 append，不動既有內容", async () => {
    await appendJournal(dir, { date: "2026-06-19", title: "新回合", body: "沈奕做了某事。" });
    const md = await readFile(path.join(dir, "journal.md"), "utf8");
    expect(md).toContain("## [2026-06-18] 既有段");
    expect(md).toContain("## [2026-06-19] 新回合");
    expect(md).toContain("沈奕做了某事。");
    // 新段在舊段之後（append-only）
    expect(md.indexOf("新回合")).toBeGreaterThan(md.indexOf("既有段"));
  });
});
