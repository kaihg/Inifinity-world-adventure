import { describe, it, expect } from "vitest";
import {
  buildDungeonMessages,
  buildFastControlMessages,
  buildMainSpaceMessages,
  buildPacingMessages,
} from "./prompts.js";
import type { GameState } from "../context.js";

const sampleState: GameState = {
  now: {
    chapter: "第一章", scene: "安全區", companions: "葉晴",
    activeDungeon: "無", threads: "", nextStep: "", lastUpdated: "",
  },
  protagonist: { name: "沈奕", points: "0" },
  protagonistDetail: {
    name: "沈奕", points: "0",
    attributes: "力量 8、敏捷 12",
    skills: "瞬步（消耗 20 積分）",
    items: "強化手槍（彈藥 6）",
    buffs: "新手保護（3 場）",
  },
  npcs: [],
  mode: "main-space",
  lastTurn: null,
};

function makeFakeState(): GameState {
  return {
    now: { chapter: "c", scene: "s", companions: "", activeDungeon: "無", threads: "", nextStep: "", lastUpdated: "" },
    protagonist: { name: "沈奕", points: "100" },
    protagonistDetail: { name: "沈奕", points: "100", attributes: "", skills: "", items: "", buffs: "" },
    npcs: [],
    mode: "main-space",
    lastTurn: null,
  };
}

describe("buildMainSpaceMessages", () => {
  it("system 含設定、canonical 與骰值，但不再含 JSON 輸出要求", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "禁止竄改數值。", state: sampleState, input: "我四處看看", dicePool: [7, 42],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁止竄改數值");
    expect(msgs[0].content).toContain("[7, 42]");
    expect(msgs[0].content).not.toContain("===STATE===");
    expect(msgs[0].content).not.toContain("awaiting_user_input");
    // 主角詳細狀態（技能/物品/buff）須注入，敘事才能正確演出技能/道具使用
    expect(msgs[0].content).toContain("瞬步（消耗 20 積分）");
    expect(msgs[0].content).toContain("強化手槍（彈藥 6）");
    expect(msgs[0].content).toContain("新手保護（3 場）");
    expect(msgs[0].content).toContain("力量 8、敏捷 12");
    expect(msgs[0].content).toContain("第三人稱");
    expect(msgs[0].content).toContain("絕不可用「你」指稱主角");
    // 繁體中文/台灣用詞規範（共用 TRADITIONAL_CHINESE_RULE，根因 C 第三道防線）
    expect(msgs[0].content).toContain("避免中國大陸簡體中文慣用詞彙");
    expect(msgs[1]).toEqual({ role: "user", content: "我四處看看" });
  });

  it("intentsBlock 有值時出現在 system prompt", () => {
    const params = {
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      intentsBlock: "## 在場角色本回合意圖\n### 葉晴（yeqing）\n- 立場：觀察",
    };
    const msgs = buildMainSpaceMessages(params);
    expect(msgs[0].content).toContain("## 在場角色本回合意圖");
  });

  it("intentsBlock 為空字串時 system prompt 不含意圖區塊標題", () => {
    const params = {
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      intentsBlock: "",
    };
    const msgs = buildMainSpaceMessages(params);
    expect(msgs[0].content).not.toContain("## 在場角色本回合意圖");
  });

  it("wikiBlock 非空時注入 system prompt", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      wikiBlock: "## 已知實體索引\n### 技能\n- [[基礎戰術反應]]：強化戰術的 E 級技能",
    });
    expect(msgs[0].content).toContain("已知實體索引");
    expect(msgs[0].content).toContain("基礎戰術反應");
  });

  it("wikiBlock 為空時不注入", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
    });
    expect(msgs[0].content).not.toContain("已知實體索引");
  });
});

describe("buildDungeonMessages", () => {
  it("system 含第三人稱鐵則、wiki/secrets、骰值", () => {
    const msgs = buildDungeonMessages({
      settingText: "設定", state: sampleState, input: "往前走", dicePool: [5],
      dungeonId: "U-001", wiki: "入口有三道門", secrets: "地板會塌",
    });
    expect(msgs[0].content).toContain("第三人稱");
    expect(msgs[0].content).toContain("絕不可用「你」指稱主角");
    expect(msgs[0].content).toContain("U-001");
    expect(msgs[0].content).toContain("入口有三道門");
  });

  it("wikiBlock 非空時注入 system prompt", () => {
    const msgs = buildDungeonMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      dungeonId: "d1",
      wiki: "",
      secrets: "",
      wikiBlock: "## 已知實體索引\n### 技能\n- [[基礎戰術反應]]：強化戰術的 E 級技能",
    });
    expect(msgs[0].content).toContain("已知實體索引");
    expect(msgs[0].content).toContain("基礎戰術反應");
  });

  it("wikiBlock 為空時不注入", () => {
    const msgs = buildDungeonMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      dungeonId: "d1",
      wiki: "",
      secrets: "",
    });
    expect(msgs[0].content).not.toContain("已知實體索引");
  });
});

describe("buildFastControlMessages（Layer 2）", () => {
  it("主空間：system 含 awaiting_user_input、骰值、現有副本 id，不含 lore 欄位說明", () => {
    const msgs = buildFastControlMessages({
      settingText: "設定", state: sampleState, input: "我四處看看",
      narrative: "沈奕走進資訊室，擲出 42 成功避開警衛。",
      dicePool: [42, 7], existingDungeonIds: ["U-001", "abandoned-hospital"],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("awaiting_user_input");
    expect(msgs[0].content).toContain("[42, 7]");
    expect(msgs[0].content).toContain("U-001");
    expect(msgs[0].content).toContain("abandoned-hospital");
    expect(msgs[0].content).toContain("沈奕走進資訊室");
    expect(msgs[0].content).not.toContain("touched_entities");
    expect(msgs[0].content).not.toContain("dungeon_wiki_excerpt");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("我四處看看");
  });

  it("Layer 2 不再含 protagonist_updates / protagonist_points_delta 欄位說明", () => {
    const msgs = buildFastControlMessages({
      settingText: "設定", state: sampleState, input: "看看四周",
      narrative: "沈奕環顧四周。", dicePool: [1],
    });
    expect(msgs[0].content).not.toContain("protagonist_updates");
    expect(msgs[0].content).not.toContain("protagonist_points_delta");
  });

  it("副本：mode_transition 規則改為 settle_dungeon", () => {
    const msgs = buildFastControlMessages({
      settingText: "設定", state: sampleState, input: "往前走",
      narrative: "沈奕抵達出口。", dicePool: [5], existingDungeonIds: ["U-001"],
      dungeonId: "U-001", wiki: "入口有三道門", secrets: "地板會塌",
    });
    expect(msgs[0].content).toContain("U-001");
    expect(msgs[0].content).toContain("settle_dungeon");
  });
});


describe("nudgeBlock / pacingBlock 注入", () => {
  it("nudgeBlock 有值時出現在主空間 system prompt", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      nudgeBlock: "## 節奏建議（短期）\n最近幾回合的劇情進展趨於重複。",
    });
    expect(msgs[0].content).toContain("## 節奏建議（短期）");
  });

  it("pacingBlock 有值時出現在副本 system prompt", () => {
    const msgs = buildDungeonMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      dungeonId: "d1",
      wiki: "",
      secrets: "",
      pacingBlock: "## 節奏建議（長期，劇本大師）\n該開新副本了。",
    });
    expect(msgs[0].content).toContain("## 節奏建議（長期，劇本大師）");
  });

  it("nudgeBlock/pacingBlock 都未提供時不出現任一標題", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
    });
    expect(msgs[0].content).not.toContain("## 節奏建議");
  });
});

describe("buildPacingMessages", () => {
  it("system 含歷史摘要時間線與當前局勢，user 是固定請求", () => {
    const msgs = buildPacingMessages({
      settingText: "設定",
      state: makeFakeState(),
      entries: [
        { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "沈奕整理裝備" },
        { timestamp: "2026-06-23T10:05:00", mode: "副本:d1", summary: "葉晴擊倒喪屍" },
      ],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("劇本大師");
    expect(msgs[0].content).toContain("沈奕整理裝備");
    expect(msgs[0].content).toContain("(副本:d1)");
    expect(msgs[1]).toEqual({ role: "user", content: "請給這回合的長期節奏建議。" });
  });

  it("沒有歷史摘要時仍正常產出，標示尚無記錄", () => {
    const msgs = buildPacingMessages({ settingText: "設定", state: makeFakeState(), entries: [] });
    expect(msgs[0].content).toContain("（尚無記錄）");
  });
});
