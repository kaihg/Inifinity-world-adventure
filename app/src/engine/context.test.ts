import { describe, it, expect } from "vitest";
import {
  parseNow,
  isInDungeon,
  parseProtagonist,
  parseProtagonistDetail,
  parseCharacterIndex,
  applyPointsDelta,
  loadState,
} from "./context.js";
import { loadConfig } from "../config.js";

const SAMPLE_NOW = `# 當前局勢（Now）

> resume 入口：先讀這份。

- 當前篇章：第一章·初次篩選——準備過夜
- 此刻場景/地點：安全區休息區
- 在場同伴/相關 NPC：
  - **葉晴**（yeqing）：夜間警戒
  - **林思雨**（linsiyu）：同組過夜
- 進行中的副本：無
- 未解懸念/伏筆：
  - 系統倒數無預警調整
  - 潛力指數用途未知
- 主角下一步打算：在休息區過夜
- 最後更新：[2026-06-19] 建立警戒
`;

describe("parseNow", () => {
  it("解析七個固定欄位", () => {
    const now = parseNow(SAMPLE_NOW);
    expect(now.chapter).toContain("第一章");
    expect(now.scene).toBe("安全區休息區");
    expect(now.activeDungeon).toBe("無");
    expect(now.nextStep).toBe("在休息區過夜");
    expect(now.lastUpdated).toContain("2026-06-19");
  });

  it("巢狀子項併入該欄位內容", () => {
    const now = parseNow(SAMPLE_NOW);
    expect(now.companions).toContain("葉晴");
    expect(now.companions).toContain("林思雨");
    expect(now.threads).toContain("潛力指數");
  });
});

describe("parseNow — 容錯", () => {
  // 實際 now.md 會夾帶七欄之外的臨時欄位（積分狀態、已備妥物資…），
  // 這些頂層欄位不可被吸收進前一個欄位，否則 activeDungeon 被汙染、mode 誤判。
  const WITH_EXTRA = `- 進行中的副本：無
- 積分狀態：0（尚未進副本）
- 已備妥物資：剩餘約 3 天份量
- 未解懸念/伏筆：
  - 系統倒數無預警調整
- 主角下一步打算：過夜
- 最後更新：[2026-06-19]
`;

  it("七欄之外的頂層欄位不汙染前一欄位", () => {
    const now = parseNow(WITH_EXTRA);
    expect(now.activeDungeon).toBe("無");
    expect(now.threads).toContain("系統倒數");
    expect(now.threads).not.toContain("積分狀態");
  });

  it("夾帶臨時欄位時 isInDungeon 仍正確判為 false", () => {
    expect(isInDungeon(parseNow(WITH_EXTRA))).toBe(false);
  });
});

describe("isInDungeon", () => {
  it("進行中的副本為『無』時回 false", () => {
    expect(isInDungeon(parseNow(SAMPLE_NOW))).toBe(false);
  });

  it("進行中的副本有 dungeon-id 時回 true", () => {
    const md = SAMPLE_NOW.replace("進行中的副本：無", "進行中的副本：U-001 + run-1");
    expect(isInDungeon(parseNow(md))).toBe(true);
  });
});

describe("parseProtagonist", () => {
  it("擷取姓名與當前積分", () => {
    const md = `# 主角檔案
## 基本資訊
- 姓名：沈奕
## 積分與兌換
- 當前積分：12
`;
    const p = parseProtagonist(md);
    expect(p.name).toBe("沈奕");
    expect(p.points).toBe("12");
  });
});

describe("parseProtagonistDetail", () => {
  const md = `# 主角檔案
## 基本資訊
- 姓名：沈奕
## 積分與兌換
- 當前積分：7
## 屬性
- 力量：中等偏上
- 敏捷：中等
## 技能 / 異能
- （無）
## 物品欄
- 戰術刀
## Buff / Debuff / 狀態
- 輕傷
## 備註
- 新手保護：3 次
`;
  it("擷取各區塊內容", () => {
    const d = parseProtagonistDetail(md);
    expect(d.name).toBe("沈奕");
    expect(d.points).toBe("7");
    expect(d.attributes).toContain("力量：中等偏上");
    expect(d.skills).toContain("（無）");
    expect(d.items).toContain("戰術刀");
    expect(d.buffs).toContain("輕傷");
    // 不可把下一個區塊吃進來
    expect(d.attributes).not.toContain("技能");
  });
});

describe("parseCharacterIndex", () => {
  const md = `# 角色索引
| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |
|----|------|------|----------|--------------|
| protagonist | 沈奕 | 主角 | 安全區 | - |
| yeqing | 葉晴 | NPC / 潛在隊友 | 結盟 | - |
| linsiyu | 林思雨 | NPC | 跟隨 | - |

## 鎖定事實
`;
  it("解析表格、排除 protagonist", () => {
    const npcs = parseCharacterIndex(md);
    expect(npcs).toHaveLength(2);
    expect(npcs[0]).toEqual({ id: "yeqing", name: "葉晴", role: "NPC / 潛在隊友", status: "結盟" });
    expect(npcs.map((n) => n.id)).not.toContain("protagonist");
  });
});

describe("applyPointsDelta", () => {
  it("正負 delta 都正確累加", () => {
    expect(applyPointsDelta("- 當前積分：5\n", 3)).toContain("- 當前積分：8");
    expect(applyPointsDelta("- 當前積分：10\n", -4)).toContain("- 當前積分：6");
  });
  it("delta 為 0 時原樣返回", () => {
    expect(applyPointsDelta("- 當前積分：5\n", 0)).toBe("- 當前積分：5\n");
  });
});

describe("loadState（讀實際 world/）", () => {
  it("回傳 now/protagonist/mode，欄位非空", async () => {
    const worldDir = loadConfig({}).worldDir;
    const state = await loadState(worldDir);
    expect(state.now.chapter).not.toBe("");
    expect(state.protagonist.name).toBe("沈奕");
    expect(["main-space", "dungeon"]).toContain(state.mode);
  });
});
