import { describe, it, expect } from "vitest";
import type { ServerResponse } from "node:http";
import { registerTurnRoutes, safeWrite } from "./turn.js";

describe("registerTurnRoutes", () => {
  it("exports registerTurnRoutes as a function", () => {
    expect(typeof registerTurnRoutes).toBe("function");
  });
});

describe("safeWrite", () => {
  it("socket 已關閉時寫入拋錯，不傳播出去", () => {
    const brokenRaw = {
      write: () => { throw new Error("ERR_HTTP_HEADERS_SENT"); },
    } as unknown as ServerResponse;
    expect(() => safeWrite(brokenRaw, "data: test\n\n")).not.toThrow();
  });

  it("正常 socket 時正常寫入", () => {
    let written = "";
    const fakeRaw = {
      write: (data: string) => { written += data; },
    } as unknown as ServerResponse;
    safeWrite(fakeRaw, "data: hello\n\n");
    expect(written).toBe("data: hello\n\n");
  });
});
