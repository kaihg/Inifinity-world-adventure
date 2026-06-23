import { describe, it, expect } from "vitest";
import { nowISOSeconds, AUTO_CONTINUE_INPUT } from "./shared.js";

describe("nowISOSeconds", () => {
  it("回傳到秒的 ISO timestamp（無毫秒、無時區字尾）", () => {
    const ts = nowISOSeconds();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("AUTO_CONTINUE_INPUT", () => {
  it("是非空字串常數", () => {
    expect(typeof AUTO_CONTINUE_INPUT).toBe("string");
    expect(AUTO_CONTINUE_INPUT.length).toBeGreaterThan(0);
  });
});
