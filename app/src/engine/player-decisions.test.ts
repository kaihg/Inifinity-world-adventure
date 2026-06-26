import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendPlayerDecision, readPlayerDecisions } from "./player-decisions.js";

describe("appendPlayerDecision", () => {
  let worldDir: string;

  beforeEach(async () => {
    worldDir = await mkdtemp(path.join(tmpdir(), "iwa-player-decisions-"));
  });

  afterEach(async () => {
    await rm(worldDir, { recursive: true, force: true });
  });

  it("appendPlayerDecision 會把玩家輸入 append 到 world/player-decisions.md", async () => {
    await appendPlayerDecision(worldDir, {
      turnId: "turn-1",
      protagonistGeneration: 2,
      createdAt: "2026-06-26T10:00:00Z",
      input: "觀察四周",
    });
    const md = await readFile(path.join(worldDir, "player-decisions.md"), "utf8");
    expect(md).toContain("turn-1");
    expect(md).toContain("主角代數：2");
    expect(md).toContain("觀察四周");
  });

  it("首次寫入時加入標頭「# 玩家決策記錄」", async () => {
    await appendPlayerDecision(worldDir, {
      turnId: "turn-1",
      protagonistGeneration: 1,
      createdAt: "2026-06-26T10:00:00Z",
      input: "環顧四周",
    });
    const md = await readFile(path.join(worldDir, "player-decisions.md"), "utf8");
    expect(md).toContain("# 玩家決策記錄");
  });

  it("第二次寫入不重複加入標頭", async () => {
    await appendPlayerDecision(worldDir, {
      turnId: "turn-1",
      protagonistGeneration: 1,
      createdAt: "2026-06-26T10:00:00Z",
      input: "第一個動作",
    });
    await appendPlayerDecision(worldDir, {
      turnId: "turn-2",
      protagonistGeneration: 1,
      createdAt: "2026-06-26T10:01:00Z",
      input: "第二個動作",
    });
    const md = await readFile(path.join(worldDir, "player-decisions.md"), "utf8");
    const count = (md.match(/# 玩家決策記錄/g) ?? []).length;
    expect(count).toBe(1);
    expect(md).toContain("turn-1");
    expect(md).toContain("turn-2");
  });

  it("多次 append 保留所有歷史紀錄", async () => {
    await appendPlayerDecision(worldDir, {
      turnId: "turn-1",
      protagonistGeneration: 1,
      createdAt: "2026-06-26T10:00:00Z",
      input: "第一個動作",
    });
    await appendPlayerDecision(worldDir, {
      turnId: "turn-2",
      protagonistGeneration: 1,
      createdAt: "2026-06-26T10:01:00Z",
      input: "第二個動作",
    });
    const md = await readFile(path.join(worldDir, "player-decisions.md"), "utf8");
    expect(md).toContain("第一個動作");
    expect(md).toContain("第二個動作");
  });
});

describe("readPlayerDecisions", () => {
  let worldDir: string;

  beforeEach(async () => {
    worldDir = await mkdtemp(path.join(tmpdir(), "iwa-player-decisions-read-"));
  });

  afterEach(async () => {
    await rm(worldDir, { recursive: true, force: true });
  });

  it("檔案不存在時回傳空陣列", async () => {
    const result = await readPlayerDecisions(worldDir);
    expect(result).toEqual([]);
  });

  it("append 後可以讀回相同的 entry 資料", async () => {
    const entry = {
      turnId: "turn-abc",
      protagonistGeneration: 3,
      createdAt: "2026-06-26T12:00:00Z",
      input: "往左走",
    };
    await appendPlayerDecision(worldDir, entry);
    const decisions = await readPlayerDecisions(worldDir);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].turnId).toBe("turn-abc");
    expect(decisions[0].protagonistGeneration).toBe(3);
    expect(decisions[0].createdAt).toBe("2026-06-26T12:00:00Z");
    expect(decisions[0].input).toBe("往左走");
  });

  it("多筆 append 後按順序讀回", async () => {
    await appendPlayerDecision(worldDir, {
      turnId: "turn-1",
      protagonistGeneration: 1,
      createdAt: "2026-06-26T10:00:00Z",
      input: "第一個動作",
    });
    await appendPlayerDecision(worldDir, {
      turnId: "turn-2",
      protagonistGeneration: 1,
      createdAt: "2026-06-26T10:01:00Z",
      input: "第二個動作",
    });
    const decisions = await readPlayerDecisions(worldDir);
    expect(decisions).toHaveLength(2);
    expect(decisions[0].turnId).toBe("turn-1");
    expect(decisions[1].turnId).toBe("turn-2");
  });
});
