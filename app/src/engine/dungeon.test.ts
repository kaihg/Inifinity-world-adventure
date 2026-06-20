import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseActiveDungeon,
  formatActiveDungeon,
  nextRunId,
  enterDungeon,
  appendRun,
  loadDungeonLore,
  appendWikiReveals,
  listDungeonIds,
} from "./dungeon.js";

describe("parseActiveDungeon / formatActiveDungeon", () => {
  it("解析「<id> + <run>」", () => {
    expect(parseActiveDungeon("U-001 + run-2")).toEqual({ dungeonId: "U-001", runId: "run-2" });
  });
  it("無 / 空 → null", () => {
    expect(parseActiveDungeon("無")).toBeNull();
    expect(parseActiveDungeon("")).toBeNull();
    expect(parseActiveDungeon("無\n其他雜訊")).toBeNull();
  });
  it("format 與 parse 互逆", () => {
    const d = { dungeonId: "ABC", runId: "run-5" };
    expect(parseActiveDungeon(formatActiveDungeon(d))).toEqual(d);
  });
});

describe("nextRunId", () => {
  it("空 → run-1，否則最大序號 +1", () => {
    expect(nextRunId([])).toBe("run-1");
    expect(nextRunId(["run-1.md", "run-2.md"])).toBe("run-3");
    expect(nextRunId(["run-1.md", "run-4.md"])).toBe("run-5");
  });
});

describe("enterDungeon / appendRun / loadDungeonLore / appendWikiReveals", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-dungeon-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("首次進入建 run 檔與 secrets，回傳 run-1", async () => {
    const active = await enterDungeon(world, {
      dungeonId: "U-001",
      today: "2026-06-19",
      protagonistSummary: "沈奕（積分 0）",
      goal: "找到出口",
      secretsText: "真正的機關：地板會塌。",
    });
    expect(active).toEqual({ dungeonId: "U-001", runId: "run-1" });

    const run = await readFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "utf8");
    expect(run).toContain("2026-06-19");
    expect(run).toContain("沈奕");
    expect(run).toContain("找到出口");

    const secrets = await readFile(path.join(world, "dungeons", "U-001", "secrets.md"), "utf8");
    expect(secrets).toContain("地板會塌");
  });

  it("再次進入同副本：run-2，且不覆寫既有 secrets", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-19", protagonistSummary: "x", goal: "g", secretsText: "原始真相" });
    const active2 = await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-20", protagonistSummary: "x", goal: "g", secretsText: "新真相（不該寫入）" });
    expect(active2.runId).toBe("run-2");
    const secrets = await readFile(path.join(world, "dungeons", "U-001", "secrets.md"), "utf8");
    expect(secrets).toContain("原始真相");
    expect(secrets).not.toContain("不該寫入");
    const runs = await readdir(path.join(world, "dungeons", "U-001", "runs"));
    expect(runs.sort()).toEqual(["run-1.md", "run-2.md"]);
  });

  it("appendRun 追加段落；loadDungeonLore 讀 wiki+secrets（缺檔回空）", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-19", protagonistSummary: "x", goal: "g", secretsText: "真相" });
    await appendRun(world, "U-001", "run-1", { date: "2026-06-19", title: "回合一", body: "發生了事" });
    const run = await readFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "utf8");
    expect(run).toContain("## [2026-06-19] 回合一");
    expect(run).toContain("發生了事");

    const lore = await loadDungeonLore(world, "U-001");
    expect(lore.secrets).toContain("真相");
    expect(lore.wiki).toBe(""); // 尚未有 wiki

    await appendWikiReveals(world, "U-001", ["入口大廳有三道門"], "2026-06-19");
    const lore2 = await loadDungeonLore(world, "U-001");
    expect(lore2.wiki).toContain("三道門");
  });
});

describe("listDungeonIds", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-listdg-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("dungeons/ 不存在時回空陣列", async () => {
    expect(await listDungeonIds(world)).toEqual([]);
  });

  it("回傳所有副本子目錄名，忽略檔案", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "d", protagonistSummary: "x", goal: "g", secretsText: "s" });
    await enterDungeon(world, { dungeonId: "abandoned-hospital", today: "d", protagonistSummary: "x", goal: "g", secretsText: "s" });
    // 在 dungeons/ 目錄下建一個裸檔案，測試忽略檔案的行為
    await writeFile(path.join(world, "dungeons", "README.md"), "x", "utf8");
    const ids = await listDungeonIds(world);
    expect(ids.sort()).toEqual(["U-001", "abandoned-hospital"]);
    expect(ids).not.toContain("README.md");
  });
});
