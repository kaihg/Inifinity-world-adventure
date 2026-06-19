import { describe, it, expect } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("測試環境（NODE_ENV=test）一律 silent，無視傳入的 level", () => {
    const log = createLogger({ level: "debug" });
    expect(log.level).toBe("silent");
  });

  it("非測試環境採用傳入的 level", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const log = createLogger({ level: "warn", pretty: false });
      expect(log.level).toBe("warn");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("非測試環境未指定 level 時退回 info", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const log = createLogger({ pretty: false });
      expect(log.level).toBe("info");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
