import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendJournalSummary, readJournalSummaryEntries } from "./journal-summary.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "iwa-journal-summary-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appendJournalSummary", () => {
  it("檔案不存在時建立檔案並寫入第一行", async () => {
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "沈奕整理裝備" });
    const md = await readFile(path.join(dir, "journal_summary.md"), "utf8");
    expect(md).toBe("- [2026-06-23T10:00:00] (主空間) 沈奕整理裝備\n");
  });

  it("連續呼叫兩次會 append 而非覆寫，順序保留", async () => {
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "第一筆" });
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:05:00", mode: "副本:d1", summary: "第二筆" });
    const md = await readFile(path.join(dir, "journal_summary.md"), "utf8");
    const lines = md.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("第一筆");
    expect(lines[1]).toContain("第二筆");
    expect(md.indexOf("第一筆")).toBeLessThan(md.indexOf("第二筆"));
  });
});

describe("readJournalSummaryEntries", () => {
  it("檔案不存在時回傳空陣列", async () => {
    expect(await readJournalSummaryEntries(dir)).toEqual([]);
  });

  it("正確解析多行，含主空間與副本兩種 mode 標記", async () => {
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "沈奕整理裝備" });
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:05:00", mode: "副本:abandoned-hospital", summary: "葉晴擊倒喪屍" });
    const entries = await readJournalSummaryEntries(dir);
    expect(entries).toEqual([
      { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "沈奕整理裝備" },
      { timestamp: "2026-06-23T10:05:00", mode: "副本:abandoned-hospital", summary: "葉晴擊倒喪屍" },
    ]);
  });
});
