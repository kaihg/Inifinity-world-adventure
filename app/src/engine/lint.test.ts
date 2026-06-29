import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLint } from "./lint.js";
import { createSilentLogger } from "../logger.js";

let tmpDir: string;
const log = createSilentLogger();
beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "lint-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("runLint", () => {
  it("returns no issues for empty world", async () => {
    await writeFile(path.join(tmpDir, "now.md"), "# 當前局勢\n", "utf8");
    await writeFile(path.join(tmpDir, "journal.md"), "", "utf8");
    const issues = await runLint(tmpDir, log);
    expect(issues).toHaveLength(0);
  });

  it("warns when skills/wiki.md missing but entity files exist", async () => {
    await mkdir(path.join(tmpDir, "skills"), { recursive: true });
    await writeFile(path.join(tmpDir, "skills", "邏輯推理.md"), "# 邏輯推理", "utf8");
    await writeFile(path.join(tmpDir, "now.md"), "", "utf8");
    await writeFile(path.join(tmpDir, "journal.md"), "", "utf8");
    const issues = await runLint(tmpDir, log);
    const wikiIssue = issues.find((i) => i.message.includes("wiki.md") && i.file.includes("skills"));
    expect(wikiIssue).toBeDefined();
  });
});
