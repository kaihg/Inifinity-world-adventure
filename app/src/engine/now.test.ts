import { describe, it, expect } from "vitest";
import { bumpNowUpdated, serializeNow, applyNowChanges } from "./now.js";
import { parseNow } from "./context.js";

const NOW = `# 當前局勢（Now）

- 當前篇章：第一章
- 進行中的副本：無
- 最後更新：[2026-06-18] 舊摘要
`;

describe("bumpNowUpdated", () => {
  it("只覆寫『最後更新』行，其餘不動（lossless）", () => {
    const out = bumpNowUpdated(NOW, { date: "2026-06-19", summary: "新摘要" });
    expect(out).toContain("- 最後更新：[2026-06-19] 新摘要");
    expect(out).not.toContain("[2026-06-18] 舊摘要");
    expect(out).toContain("- 當前篇章：第一章");
    expect(out).toContain("- 進行中的副本：無");
  });

  it("沒有『最後更新』行時於結尾補一行", () => {
    const out = bumpNowUpdated("- 當前篇章：第一章\n", { date: "2026-06-19", summary: "x" });
    expect(out).toContain("- 最後更新：[2026-06-19] x");
  });
});

const BASE = {
  chapter: "第一章", scene: "安全區", companions: "葉晴（yeqing）",
  activeDungeon: "無", threads: "懸念一", nextStep: "準備 U-001", lastUpdated: "[2026-06-18] 舊",
};

describe("serializeNow + parseNow round-trip", () => {
  it("序列化後再解析回得到同樣七欄", () => {
    const md = serializeNow(BASE);
    const back = parseNow(md);
    expect(back.chapter).toBe("第一章");
    expect(back.scene).toBe("安全區");
    expect(back.activeDungeon).toBe("無");
    expect(back.nextStep).toBe("準備 U-001");
  });

  it("產出含七個固定欄位標籤", () => {
    const md = serializeNow(BASE);
    for (const label of ["當前篇章", "此刻場景/地點", "在場同伴/相關 NPC", "進行中的副本", "未解懸念/伏筆", "主角下一步打算", "最後更新"]) {
      expect(md).toContain(`- ${label}：`);
    }
  });
});

describe("applyNowChanges", () => {
  it("只覆寫有提供的欄位，其餘保留；更新時間戳", () => {
    const out = applyNowChanges(BASE, { scene: "資訊室", nextStep: "找葉晴" }, { date: "2026-06-19", summary: "前往資訊室" });
    expect(out.scene).toBe("資訊室");
    expect(out.nextStep).toBe("找葉晴");
    expect(out.chapter).toBe("第一章"); // 未提供 → 保留
    expect(out.lastUpdated).toBe("[2026-06-19] 前往資訊室");
  });
});
