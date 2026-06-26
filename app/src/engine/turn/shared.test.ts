import { describe, it, expect } from "vitest";
import { nowISOSeconds } from "./shared.js";

describe("nowISOSeconds", () => {
  it("回傳到秒的 ISO timestamp（無毫秒、無時區字尾）", () => {
    const ts = nowISOSeconds();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});
