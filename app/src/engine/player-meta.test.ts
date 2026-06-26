import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensurePlayerMeta,
  nextEpitaphId,
  createEpitaphDir,
  appendPlayerMetaIndex,
  incrementPlayerCounts,
  readPlayerMetaCounts,
  type PlayerMetaIndexEntry,
} from "./player-meta.js";

describe("nextEpitaphId", () => {
  it("格式為 epi-YYYYMMDD-XXX（三位補零）", () => {
    expect(nextEpitaphId("2026-06-26", 1)).toBe("epi-20260626-001");
    expect(nextEpitaphId("2026-06-26", 10)).toBe("epi-20260626-010");
    expect(nextEpitaphId("2026-06-26", 100)).toBe("epi-20260626-100");
  });

  it("主角代數超過 999 也不截斷", () => {
    expect(nextEpitaphId("2026-06-26", 1000)).toBe("epi-20260626-1000");
  });
});

describe("ensurePlayerMeta", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-playermeta-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("ensurePlayerMeta 會建立 meta/player.md 與 meta/epitaphs/", async () => {
    await ensurePlayerMeta(repoRoot);
    expect(await readFile(path.join(repoRoot, "meta", "player.md"), "utf8")).toContain("已封存世界數：0");
    expect(await stat(path.join(repoRoot, "meta", "epitaphs"))).toBeDefined();
  });

  it("player.md 初始內容包含已結算主角代數：0", async () => {
    await ensurePlayerMeta(repoRoot);
    const md = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(md).toContain("已結算主角代數：0");
  });

  it("player.md 初始內容包含墓誌銘索引表頭", async () => {
    await ensurePlayerMeta(repoRoot);
    const md = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    // 表頭行
    expect(md).toMatch(/\|.*墓誌銘.*\|/);
  });

  it("重複呼叫 ensurePlayerMeta 是冪等的（不覆蓋已有內容）", async () => {
    await ensurePlayerMeta(repoRoot);
    const before = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    await ensurePlayerMeta(repoRoot);
    const after = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(after).toBe(before);
  });
});

describe("readPlayerMetaCounts", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-playermeta-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("初始值均為 0", async () => {
    await ensurePlayerMeta(repoRoot);
    const counts = await readPlayerMetaCounts(repoRoot);
    expect(counts.worldHistoryCount).toBe(0);
    expect(counts.protagonistGenerationCount).toBe(0);
  });
});

describe("incrementPlayerCounts", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-playermeta-"));
    await ensurePlayerMeta(repoRoot);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("可分別增加 worldHistoryDelta", async () => {
    await incrementPlayerCounts(repoRoot, { worldHistoryDelta: 1 });
    const md = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(md).toContain("已封存世界數：1");
    expect(md).toContain("已結算主角代數：0");
  });

  it("可分別增加 protagonistGenerationDelta", async () => {
    await incrementPlayerCounts(repoRoot, { protagonistGenerationDelta: 1 });
    const md = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(md).toContain("已封存世界數：0");
    expect(md).toContain("已結算主角代數：1");
  });

  it("兩個計數同時增加", async () => {
    await incrementPlayerCounts(repoRoot, { worldHistoryDelta: 2, protagonistGenerationDelta: 3 });
    const counts = await readPlayerMetaCounts(repoRoot);
    expect(counts.worldHistoryCount).toBe(2);
    expect(counts.protagonistGenerationCount).toBe(3);
  });

  it("累積多次增加", async () => {
    await incrementPlayerCounts(repoRoot, { worldHistoryDelta: 1 });
    await incrementPlayerCounts(repoRoot, { worldHistoryDelta: 1 });
    await incrementPlayerCounts(repoRoot, { protagonistGenerationDelta: 1 });
    const counts = await readPlayerMetaCounts(repoRoot);
    expect(counts.worldHistoryCount).toBe(2);
    expect(counts.protagonistGenerationCount).toBe(1);
  });
});

describe("createEpitaphDir", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-playermeta-"));
    await ensurePlayerMeta(repoRoot);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("在 meta/epitaphs/<epitaphId>/ 建立目錄並回傳絕對路徑", async () => {
    const epitaphId = "epi-20260626-001";
    const result = await createEpitaphDir(repoRoot, epitaphId);
    const expected = path.join(repoRoot, "meta", "epitaphs", epitaphId);
    expect(result).toBe(expected);
    const s = await stat(result);
    expect(s.isDirectory()).toBe(true);
  });

  it("重複呼叫是冪等的", async () => {
    const epitaphId = "epi-20260626-001";
    await createEpitaphDir(repoRoot, epitaphId);
    await expect(createEpitaphDir(repoRoot, epitaphId)).resolves.not.toThrow();
  });
});

describe("appendPlayerMetaIndex", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-playermeta-"));
    await ensurePlayerMeta(repoRoot);
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("appendPlayerMetaIndex 會新增墓誌銘索引列並更新計數", async () => {
    await incrementPlayerCounts(repoRoot, { protagonistGenerationDelta: 1, worldHistoryDelta: 1 });
    await appendPlayerMetaIndex(repoRoot, {
      epitaphId: "epi-20260626-001",
      worldUuid: "550e8400-e29b-41d4-a716-446655440000",
      protagonistGeneration: 1,
      protagonistName: "沈奕",
      endingType: "死亡",
      createdAt: "2026-06-26",
    });
    const md = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(md).toContain("已封存世界數：1");
    expect(md).toContain("| epi-20260626-001 | 550e8400-e29b-41d4-a716-446655440000 | 1 | 沈奕 | 死亡 | 2026-06-26 |");
  });

  it("多筆墓誌銘依序追加", async () => {
    const entry1: PlayerMetaIndexEntry = {
      epitaphId: "epi-20260626-001",
      worldUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      protagonistGeneration: 1,
      protagonistName: "沈奕",
      endingType: "死亡",
      createdAt: "2026-06-26",
    };
    const entry2: PlayerMetaIndexEntry = {
      epitaphId: "epi-20260626-002",
      worldUuid: "ffffffff-0000-1111-2222-333333333333",
      protagonistGeneration: 2,
      protagonistName: "林思雨",
      endingType: "通關",
      createdAt: "2026-06-27",
    };
    await appendPlayerMetaIndex(repoRoot, entry1);
    await appendPlayerMetaIndex(repoRoot, entry2);
    const md = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(md).toContain("| epi-20260626-001 |");
    expect(md).toContain("| epi-20260626-002 |");
    // entry2 在 entry1 之後
    expect(md.indexOf("epi-20260626-002")).toBeGreaterThan(md.indexOf("epi-20260626-001"));
  });
});
