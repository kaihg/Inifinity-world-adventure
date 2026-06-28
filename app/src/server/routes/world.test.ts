import { describe, it, expect } from "vitest";
import { registerWorldRoutes } from "./world.js";

describe("registerWorldRoutes", () => {
  it("exports registerWorldRoutes as a function", () => {
    expect(typeof registerWorldRoutes).toBe("function");
  });
});
