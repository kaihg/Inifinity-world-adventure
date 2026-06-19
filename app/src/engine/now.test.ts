import { describe, it, expect } from "vitest";
import { bumpNowUpdated } from "./now.js";

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
