import { describe, it, expect } from "vitest";
import { createNarrativeSplitter } from "./stream-split.js";

describe("createNarrativeSplitter", () => {
  it("只轉發 sentinel 之前的敘事，sentinel 之後不轉發", () => {
    const s = createNarrativeSplitter();
    let out = "";
    out += s.push("你好");
    out += s.push("世界\n===STA");
    out += s.push("TE===\n{\"a\":1}");
    expect(out).toBe("你好世界\n");
    expect(s.full()).toContain("===STATE===");
  });

  it("沒有 sentinel 時全部轉發為敘事", () => {
    const s = createNarrativeSplitter();
    let out = "";
    out += s.push("純敘事");
    out += s.push("沒有控制區塊");
    // flush 尾端保留字
    out += s.flush();
    expect(out).toBe("純敘事沒有控制區塊");
  });
});
