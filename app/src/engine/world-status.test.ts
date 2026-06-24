import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isWorldInitialized, UNINITIALIZED_SETTING_PLACEHOLDER } from "./world-status.js";

describe("isWorldInitialized", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-world-status-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("setting.md 不存在（從未初始化過）→ false", async () => {
    expect(await isWorldInitialized(world)).toBe(false);
  });

  it("setting.md 是佔位文字 → false", async () => {
    await writeFile(path.join(world, "setting.md"), UNINITIALIZED_SETTING_PLACEHOLDER, "utf8");
    expect(await isWorldInitialized(world)).toBe(false);
  });

  it("setting.md 是正常內容 → true", async () => {
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n冷酷機械系統。\n", "utf8");
    expect(await isWorldInitialized(world)).toBe(true);
  });

  it("佔位文字前後有多餘空白仍判定為未初始化（trim 比較）", async () => {
    await writeFile(path.join(world, "setting.md"), `\n\n${UNINITIALIZED_SETTING_PLACEHOLDER}\n\n`, "utf8");
    expect(await isWorldInitialized(world)).toBe(false);
  });
});
