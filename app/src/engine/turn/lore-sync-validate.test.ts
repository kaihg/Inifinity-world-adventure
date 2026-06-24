import { describe, it, expect } from "vitest";
import type { Logger } from "../../logger.js";
import { sanitizeTouchedEntities, reconcileEntityCategories } from "./lore-sync-validate.js";
import type { LoreEntityRef } from "../schema.js";

function fakeLogger(): { log: Logger; warnCalls: unknown[] } {
  const warnCalls: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as Logger;
  return { log, warnCalls };
}

const ent = (over: Partial<LoreEntityRef>): LoreEntityRef => ({
  id: "yeqing",
  category: "npc",
  name: "葉晴",
  excerpt: "片段",
  ...over,
});

describe("sanitizeTouchedEntities", () => {
  it("黑名單 id（system/none/unknown）一律剔除並記 warn", () => {
    const { log, warnCalls } = fakeLogger();
    const out = sanitizeTouchedEntities(
      [ent({ id: "system", category: "skill" }), ent({ id: "none" }), ent({ id: "unknown", category: "item" })],
      log,
    );
    expect(out).toHaveLength(0);
    expect(warnCalls.length).toBe(3);
  });

  it("無英數字的垃圾 id（純標點、純符號、空白、CJK、含空白）剔除", () => {
    const { log } = fakeLogger();
    const out = sanitizeTouchedEntities(
      [ent({ id: "！！" }), ent({ id: ".." }), ent({ id: "--" }), ent({ id: "__" }), ent({ id: "  " }), ent({ id: "系統" }), ent({ id: "a b" })],
      log,
    );
    expect(out).toHaveLength(0);
  });

  it("底線 snake_case id 保留（複用 repo id 慣例，不再拒絕底線）", () => {
    const { log } = fakeLogger();
    const out = sanitizeTouchedEntities(
      [
        ent({ id: "water_bottle", category: "item", name: "水壺" }),
        ent({ id: "collision_alarm_device", category: "item", name: "碰撞警報裝置" }),
      ],
      log,
    );
    expect(out.map((e) => e.id)).toEqual(["water_bottle", "collision_alarm_device"]);
  });

  it("單字元英數 id 保留（repo 慣例允許）", () => {
    const { log } = fakeLogger();
    const out = sanitizeTouchedEntities([ent({ id: "x", category: "item", name: "物件" })], log);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("x");
  });

  it("合法 slug 保留並正規化為小寫", () => {
    const { log } = fakeLogger();
    const out = sanitizeTouchedEntities([ent({ id: "Rusty-Pipe", category: "item", name: "生鏽鐵管" })], log);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("rusty-pipe");
    expect(out[0].category).toBe("item");
  });

  it("同回合同 id 跨 category：保留首見、剔除後者並 warn", () => {
    const { log, warnCalls } = fakeLogger();
    const out = sanitizeTouchedEntities(
      [
        ent({ id: "warden", category: "npc", name: "守衛" }),
        ent({ id: "warden", category: "skill", name: "守衛技能" }),
      ],
      log,
    );
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe("npc");
    expect(warnCalls.length).toBe(1);
  });

  it("同回合同 id 同 category：兩筆都保留（不是衝突）", () => {
    const { log } = fakeLogger();
    const out = sanitizeTouchedEntities(
      [ent({ id: "warden", category: "npc" }), ent({ id: "warden", category: "npc" })],
      log,
    );
    expect(out).toHaveLength(2);
  });

  it("空陣列原樣返回", () => {
    const { log } = fakeLogger();
    expect(sanitizeTouchedEntities([], log)).toEqual([]);
  });
});

describe("reconcileEntityCategories", () => {
  const empty = { npc: new Set<string>(), item: new Set<string>(), scene: new Set<string>(), skill: new Set<string>() };

  it("既有檔案是 NPC，模型誤標成 item：改回 npc 並 warn", () => {
    const { log, warnCalls } = fakeLogger();
    const out = reconcileEntityCategories(
      [ent({ id: "yeqing", category: "item" })],
      { ...empty, npc: new Set(["yeqing"]) },
      log,
    );
    expect(out[0].category).toBe("npc");
    expect(warnCalls.length).toBe(1);
  });

  it("category 與既有一致：原樣保留、不 warn", () => {
    const { log, warnCalls } = fakeLogger();
    const out = reconcileEntityCategories(
      [ent({ id: "yeqing", category: "npc" })],
      { ...empty, npc: new Set(["yeqing"]) },
      log,
    );
    expect(out[0].category).toBe("npc");
    expect(warnCalls.length).toBe(0);
  });

  it("全新實體（既有清單沒有）：原樣保留", () => {
    const { log } = fakeLogger();
    const out = reconcileEntityCategories([ent({ id: "newbie", category: "item" })], empty, log);
    expect(out[0].category).toBe("item");
  });

  it("id 同時存在多個 category 且模型給的 category 也在其中：保留模型的，不亂改", () => {
    const { log, warnCalls } = fakeLogger();
    const out = reconcileEntityCategories(
      [ent({ id: "ghost", category: "item" })],
      { ...empty, item: new Set(["ghost"]), skill: new Set(["ghost"]) },
      log,
    );
    // 模型給 item，而 item 確實是既有歸屬之一 → 不該被 last-key-wins 改成 skill
    expect(out[0].category).toBe("item");
    expect(warnCalls.length).toBe(0);
  });

  it("id 同時存在多個 category 但模型給的都不在其中：保留模型的並 warn（不武斷選一個）", () => {
    const { log, warnCalls } = fakeLogger();
    const out = reconcileEntityCategories(
      [ent({ id: "ghost", category: "npc" })],
      { ...empty, item: new Set(["ghost"]), skill: new Set(["ghost"]) },
      log,
    );
    // 既有歸屬有 item 與 skill 兩個，無從決定 → 不武斷改成 skill，保留模型的 npc 並 warn
    expect(out[0].category).toBe("npc");
    expect(warnCalls.length).toBe(1);
  });
});
