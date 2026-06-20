import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendUsageLog } from "./usage-log.js";

describe("appendUsageLog", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("把一筆紀錄 append 成一行 JSON", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "usage-log-"));
    const filePath = path.join(dir, "usage.log");
    await appendUsageLog(filePath, {
      timestamp: "2026-06-20T00:00:00.000Z",
      label: "main",
      model: "gpt-4o",
      baseUrl: "http://x/v1",
      durationMs: 1234,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
    const content = await readFile(filePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      label: "main",
      model: "gpt-4o",
      totalTokens: 150,
    });
  });

  it("多次呼叫累積成多行（append-only）", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "usage-log-"));
    const filePath = path.join(dir, "usage.log");
    await appendUsageLog(filePath, {
      timestamp: "t1",
      label: "main",
      model: "m",
      baseUrl: "b",
      durationMs: 1,
    });
    await appendUsageLog(filePath, {
      timestamp: "t2",
      label: "control",
      model: "m",
      baseUrl: "b",
      durationMs: 2,
    });
    const content = await readFile(filePath, "utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
  });

  it("目錄不存在時自動建立", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "usage-log-"));
    const filePath = path.join(dir, "nested", "usage.log");
    await appendUsageLog(filePath, {
      timestamp: "t1",
      label: "main",
      model: "m",
      baseUrl: "b",
      durationMs: 1,
    });
    const content = await readFile(filePath, "utf8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });
});
