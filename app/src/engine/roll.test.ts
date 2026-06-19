import { describe, it, expect } from "vitest";
import { cryptoD100, rollPool } from "./roll.js";

describe("rollPool", () => {
  it("用注入的 rng 依序取值", () => {
    const seq = [12, 99, 50];
    let i = 0;
    const pool = rollPool(3, () => seq[i++]);
    expect(pool).toEqual([12, 99, 50]);
  });

  it("長度正確", () => {
    expect(rollPool(5, () => 1)).toHaveLength(5);
  });
});

describe("cryptoD100", () => {
  it("值落在 1..100", () => {
    for (let i = 0; i < 500; i++) {
      const v = cryptoD100();
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});
