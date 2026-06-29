import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCursor, writeCursor, readJournalDelta } from "./ingest-cursor.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "cursor-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("ingest cursor", () => {
  it("readCursor returns 0 when cursor file missing", async () => {
    expect(await readCursor(tmpDir)).toBe(0);
  });

  it("writeCursor + readCursor round-trips offset", async () => {
    await writeCursor(tmpDir, 42);
    expect(await readCursor(tmpDir)).toBe(42);
  });

  it("readJournalDelta returns content after offset", async () => {
    const journal = "AAAA\nBBBB\nCCCC";
    await writeFile(path.join(tmpDir, "journal.md"), journal, "utf8");
    // Buffer.byteLength("AAAA\n") === 5
    const delta = await readJournalDelta(tmpDir, 5);
    expect(delta).toBe("BBBB\nCCCC");
  });

  it("readJournalDelta returns empty when offset === file length", async () => {
    const journal = "DONE";
    await writeFile(path.join(tmpDir, "journal.md"), journal, "utf8");
    const delta = await readJournalDelta(tmpDir, Buffer.byteLength(journal, "utf8"));
    expect(delta).toBe("");
  });
});
