import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loreFilePath, loadLoreFile, rewriteLoreFile, listLoreIds } from "./lore.js";

describe("lore（扁平 .md 落地：items/skills/scenes/dungeons 共用同一套規則）", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-lore-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  describe("loreFilePath", () => {
    it("回傳 world/<category>/<id>.md", () => {
      expect(loreFilePath(world, "items", "rusty-pipe")).toBe(
        path.join(world, "items", "rusty-pipe.md"),
      );
    });

    it("中文 id 正常處理", () => {
      expect(loreFilePath(world, "skills", "邏輯推理")).toBe(
        path.join(world, "skills", "邏輯推理.md"),
      );
    });
  });

  describe("loadLoreFile", () => {
    it("缺檔回空字串，不報錯", async () => {
      const result = await loadLoreFile(world, "items", "rusty-pipe");
      expect(result).toBe("");
    });

    it("有檔案時回傳完整內容", async () => {
      await mkdir(path.join(world, "items"), { recursive: true });
      await writeFile(path.join(world, "items", "rusty-pipe.md"), "# 道具\n\n內容", "utf8");
      const result = await loadLoreFile(world, "items", "rusty-pipe");
      expect(result).toBe("# 道具\n\n內容");
    });
  });

  describe("rewriteLoreFile", () => {
    it("首次建立 .md（無現有檔案時自動補標題）", async () => {
      await rewriteLoreFile(world, "skills", "melee-mastery", "可疊加三層，疊滿後解鎖突進。", "技能（melee-mastery）");
      const content = await readFile(path.join(world, "skills", "melee-mastery.md"), "utf8");
      expect(content).toContain("技能（melee-mastery）");
      expect(content).toContain("可疊加三層，疊滿後解鎖突進。");
    });

    it("第二次呼叫整檔覆寫，不殘留舊內容", async () => {
      await rewriteLoreFile(world, "skills", "melee-mastery", "可疊加三層。", "技能（melee-mastery）");
      await rewriteLoreFile(world, "skills", "melee-mastery", "可疊加五層，疊滿解鎖突進。", "技能（melee-mastery）");
      const content = await readFile(path.join(world, "skills", "melee-mastery.md"), "utf8");
      expect(content).toContain("可疊加五層，疊滿解鎖突進。");
      expect(content).not.toContain("可疊加三層。");
    });

    it("內容本身已含 # 標題時不重複加標題", async () => {
      await rewriteLoreFile(world, "items", "rusty-pipe", "# 道具（rusty-pipe）\n\n管身刻有符號。", "道具（rusty-pipe）");
      const content = await readFile(path.join(world, "items", "rusty-pipe.md"), "utf8");
      expect(content.match(/# 道具（rusty-pipe）/g)).toHaveLength(1);
    });

    it("內容以 ### 起頭時補上正確的 H1 標題（根因 I）", async () => {
      await rewriteLoreFile(world, "scenes", "panel", "### 地理/環境描述\n\n面板設於角落。", "場景（panel）");
      const content = await readFile(path.join(world, "scenes", "panel.md"), "utf8");
      expect(content.split("\n")[0]).toBe("# 場景（panel）");
      expect(content).toContain("### 地理/環境描述");
    });

    it("自動建立不存在的分類目錄", async () => {
      await rewriteLoreFile(world, "dungeons", "U-001", "入口大廳有三道門", "副本（U-001）");
      const content = await readFile(path.join(world, "dungeons", "U-001.md"), "utf8");
      expect(content).toContain("三道門");
    });
  });

  describe("listLoreIds", () => {
    it("目錄不存在時回空陣列", async () => {
      expect(await listLoreIds(world, "items")).toEqual([]);
    });

    it("列出既有 .md 檔名（去副檔名），忽略子目錄", async () => {
      await rewriteLoreFile(world, "items", "rusty-pipe", "內容", "t");
      await rewriteLoreFile(world, "items", "water-bottle", "內容", "t");
      // 在同目錄建一個子目錄，確認 listLoreIds 不列出目錄
      await mkdir(path.join(world, "items", "subdir"), { recursive: true });
      const ids = await listLoreIds(world, "items");
      expect(ids.sort()).toEqual(["rusty-pipe", "water-bottle"]);
    });

    it("wiki.md 被排除在結果之外", async () => {
      await mkdir(path.join(world, "dungeons"), { recursive: true });
      await writeFile(path.join(world, "dungeons", "wiki.md"), "index", "utf8");
      await writeFile(path.join(world, "dungeons", "U-001.md"), "副本內容", "utf8");
      const ids = await listLoreIds(world, "dungeons");
      expect(ids).toContain("U-001");
      expect(ids).not.toContain("wiki");
    });
  });
});
