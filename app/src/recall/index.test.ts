import { describe, expect, it } from "vitest";
import { formatRecallBlock } from "./index.js";
import type { RecallHit } from "./store.js";

describe("formatRecallBlock", () => {
  it("無結果回空字串", () => {
    expect(formatRecallBlock([])).toBe("");
  });

  it("把命中片段格式化為帶標題的區塊", () => {
    const hits: RecallHit[] = [
      { file: "characters/foo.md", heading: "近況", text: "受傷了", score: 0.9 },
      { file: "world/journal.md", heading: "", text: "曾經發生的事", score: 0.5 },
    ];
    const block = formatRecallBlock(hits);
    expect(block).toContain("characters/foo.md · 近況");
    expect(block).toContain("受傷了");
    expect(block).toContain("world/journal.md");
    expect(block).toContain("曾經發生的事");
  });
});
