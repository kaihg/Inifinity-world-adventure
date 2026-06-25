import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseActiveDungeon,
  formatActiveDungeon,
  enterDungeon,
  renameLogAfterSettle,
  appendLog,
  loadDungeonLore,
  listDungeonIds,
} from "./dungeon.js";
import { rewriteLoreWiki } from "./lore.js";

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

describe("renameLogAfterSettle", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-settle-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("結算後 log.md rename 成 log-run-1.md", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-25", protagonistSummary: "沈奕", goal: "測試", secretsText: "真相" });
    await renameLogAfterSettle(world, "U-001");
    const dir = path.join(world, "dungeons", "U-001");
    const files = await readdir(dir);
    expect(files).toContain("log-run-1.md");
    expect(files).not.toContain("log.md");
  });

  it("第二次進入後結算 → log-run-2.md", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-25", protagonistSummary: "沈奕", goal: "第一次", secretsText: "真相" });
    await renameLogAfterSettle(world, "U-001");
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-26", protagonistSummary: "沈奕", goal: "第二次", secretsText: "真相" });
    await renameLogAfterSettle(world, "U-001");
    const dir = path.join(world, "dungeons", "U-001");
    const files = await readdir(dir);
    expect(files).toContain("log-run-1.md");
    expect(files).toContain("log-run-2.md");
    expect(files).not.toContain("log.md");
  });

  it("log.md 不存在時靜默略過", async () => {
    await mkdir(path.join(world, "dungeons", "U-001"), { recursive: true });
    await expect(renameLogAfterSettle(world, "U-001")).resolves.toBeUndefined();
  });
});

describe("enterDungeon / appendLog / loadDungeonLore", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-dungeon-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("首次進入建 log.md 與 secrets，回傳 run-1", async () => {
    const active = await enterDungeon(world, {
      dungeonId: "U-001",
      today: "2026-06-19",
      protagonistSummary: "沈奕（積分 0）",
      goal: "找到出口",
      secretsText: "真正的機關：地板會塌。",
    });
    expect(active).toEqual({ dungeonId: "U-001", runId: "run-1" });

    const log = await readFile(path.join(world, "dungeons", "U-001", "log.md"), "utf8");
    expect(log).toContain("run-1");
    expect(log).toContain("2026-06-19");
    expect(log).toContain("沈奕");

    const secrets = await readFile(path.join(world, "dungeons", "U-001", "secrets.md"), "utf8");
    expect(secrets).toContain("地板會塌");

    // runs/ 目錄不應建立
    await expect(readdir(path.join(world, "dungeons", "U-001", "runs"))).rejects.toThrow();
  });

  it("第二次進入同一副本 → run-2，且不覆寫既有 secrets", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-20", protagonistSummary: "沈奕（積分 50）", goal: "找到隱藏出口", secretsText: "原始真相" });
    await renameLogAfterSettle(world, "U-001");  // 結算第一次
    const active = await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-21", protagonistSummary: "沈奕（積分 80）", goal: "終結副本", secretsText: "新真相（不該寫入）" });
    expect(active.runId).toBe("run-2");
    // 現在 log.md 是第二次的，log-run-1.md 是第一次的
    const log = await readFile(path.join(world, "dungeons", "U-001", "log.md"), "utf8");
    expect(log).toContain("run-2");
    const secrets = await readFile(path.join(world, "dungeons", "U-001", "secrets.md"), "utf8");
    expect(secrets).toContain("原始真相");
    expect(secrets).not.toContain("不該寫入");
  });

  it("appendLog 追加段落；loadDungeonLore 讀 wiki+secrets（缺檔回空）", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-19", protagonistSummary: "x", goal: "g", secretsText: "真相" });
    await appendLog(world, "U-001", "run-1", { date: "2026-06-19", title: "回合一", body: "發生了事" });
    const log = await readFile(path.join(world, "dungeons", "U-001", "log.md"), "utf8");
    expect(log).toContain("### [2026-06-19] 回合一");
    expect(log).toContain("發生了事");

    const lore = await loadDungeonLore(world, "U-001");
    expect(lore.secrets).toContain("真相");
    expect(lore.wiki).toBe(""); // 尚未有 wiki

    await rewriteLoreWiki(world, "dungeons", "U-001", "入口大廳有三道門", "副本 U-001 · 已揭露知識（Wiki）");
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
