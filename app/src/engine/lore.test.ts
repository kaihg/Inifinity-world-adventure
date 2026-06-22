import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadLore, ensureSecrets, rewriteLoreWiki } from "./lore.js";

describe("lore（揭露式知識共用落地：dungeons/items/skills 共用同一套規則）", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-lore-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("loadLore 缺檔回空字串，不報錯", async () => {
    const lore = await loadLore(world, "items", "rusty-pipe");
    expect(lore).toEqual({ wiki: "", secrets: "" });
  });

  it("ensureSecrets 首次寫入回 true，內容含標題與真相", async () => {
    const wrote = await ensureSecrets(world, "items", "rusty-pipe", "其實是某把武器的殘骸", "道具隱藏真相（rusty-pipe）");
    expect(wrote).toBe(true);
    const secrets = await readFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "utf8");
    expect(secrets).toContain("道具隱藏真相（rusty-pipe）");
    expect(secrets).toContain("某把武器的殘骸");
  });

  it("ensureSecrets 第二次呼叫不覆寫既有內容，回 false", async () => {
    await ensureSecrets(world, "items", "rusty-pipe", "原始真相", "title");
    const wrote2 = await ensureSecrets(world, "items", "rusty-pipe", "新真相（不該寫入）", "title");
    expect(wrote2).toBe(false);
    const secrets = await readFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "utf8");
    expect(secrets).toContain("原始真相");
    expect(secrets).not.toContain("不該寫入");
  });

  it("rewriteLoreWiki 首次建立 wiki.md（無現有檔案時自動補標題）", async () => {
    await rewriteLoreWiki(world, "skills", "melee-mastery", "可疊加三層，疊滿後解鎖突進。", "技能（melee-mastery）");
    const wiki = await readFile(path.join(world, "skills", "melee-mastery", "wiki.md"), "utf8");
    expect(wiki).toContain("技能（melee-mastery）");
    expect(wiki).toContain("可疊加三層，疊滿後解鎖突進。");
  });

  it("rewriteLoreWiki 第二次呼叫整檔覆寫，不殘留舊內容", async () => {
    await rewriteLoreWiki(world, "skills", "melee-mastery", "可疊加三層。", "技能（melee-mastery）");
    await rewriteLoreWiki(world, "skills", "melee-mastery", "可疊加五層，疊滿解鎖突進。", "技能（melee-mastery）");
    const wiki = await readFile(path.join(world, "skills", "melee-mastery", "wiki.md"), "utf8");
    expect(wiki).toContain("可疊加五層，疊滿解鎖突進。");
    expect(wiki).not.toContain("可疊加三層。");
  });

  it("LLM 輸出本身已含 # 標題時不重複加標題", async () => {
    await rewriteLoreWiki(world, "items", "rusty-pipe", "# 道具（rusty-pipe）\n\n管身刻有符號。", "道具（rusty-pipe）");
    const wiki = await readFile(path.join(world, "items", "rusty-pipe", "wiki.md"), "utf8");
    expect(wiki.match(/# 道具（rusty-pipe）/g)).toHaveLength(1);
  });

  it("loadLore 讀到 ensureSecrets/rewriteLoreWiki 寫入的內容", async () => {
    await ensureSecrets(world, "dungeons", "U-001", "地板會塌", "title");
    await rewriteLoreWiki(world, "dungeons", "U-001", "入口大廳有三道門", "title");
    const lore = await loadLore(world, "dungeons", "U-001");
    expect(lore.secrets).toContain("地板會塌");
    expect(lore.wiki).toContain("三道門");
  });

  it("locations 分類沿用同一套規則", async () => {
    await ensureSecrets(world, "locations", "info-room", "牆後藏了監聽器", "title");
    await rewriteLoreWiki(world, "locations", "info-room", "牆上有一面鏡子", "title");
    const lore = await loadLore(world, "locations", "info-room");
    expect(lore.secrets).toContain("監聽器");
    expect(lore.wiki).toContain("鏡子");
  });
});
