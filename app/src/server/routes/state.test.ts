import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerStateRoutes } from "./state.js";

describe("registerStateRoutes", () => {
  it("exports registerStateRoutes as a function", () => {
    expect(typeof registerStateRoutes).toBe("function");
  });

  it("registers GET /api/health route", async () => {
    const server = Fastify();
    registerStateRoutes(server, {
      config: {
        openai: { baseUrl: "", apiKey: "", model: "test-model" },
        typewriterIntervalMs: 25,
      } as never,
      logger: server.log as never,
      versionPromise: Promise.resolve({ hash: "abc", message: "test" }),
    });
    const res = await server.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
  });
});
