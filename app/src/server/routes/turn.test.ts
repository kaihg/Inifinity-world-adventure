import { describe, it, expect } from "vitest";
import { registerTurnRoutes } from "./turn.js";

describe("registerTurnRoutes", () => {
  it("exports registerTurnRoutes as a function", () => {
    expect(typeof registerTurnRoutes).toBe("function");
  });
});
