import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./chunk.js";

describe("chunkMarkdown", () => {
  it("依 ## 標題切塊，標頭內容歸入空字串 heading", () => {
    const md = ["# 角色檔", "一些前言", "", "## [2026-06-01] 更新", "內容 A", "## [2026-06-02] 更新", "內容 B"].join(
      "\n",
    );
    const chunks = chunkMarkdown(md);
    expect(chunks).toEqual([
      { heading: "", text: "# 角色檔\n一些前言" },
      { heading: "[2026-06-01] 更新", text: "內容 A" },
      { heading: "[2026-06-02] 更新", text: "內容 B" },
    ]);
  });

  it("沒有任何 ## 標題時整篇是單一段落", () => {
    const md = "純文字內容\n沒有標題";
    expect(chunkMarkdown(md)).toEqual([{ heading: "", text: md }]);
  });

  it("忽略空白段落", () => {
    const md = "## 標題一\n\n## 標題二\n實際內容";
    expect(chunkMarkdown(md)).toEqual([{ heading: "標題二", text: "實際內容" }]);
  });

  it("過長段落依字數切片並保留重疊", () => {
    const long = "字".repeat(3000);
    const chunks = chunkMarkdown(`## 標題\n${long}`);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.heading === "標題")).toBe(true);
    // 重疊：前一片尾段應出現在下一片開頭
    const tailOfFirst = chunks[0].text.slice(-50);
    expect(chunks[1].text.startsWith(tailOfFirst)).toBe(true);
  });

  it("空字串輸入回傳空陣列", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });
});
