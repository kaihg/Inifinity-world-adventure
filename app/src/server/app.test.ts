import { describe, it, expect } from "vitest";
import { buildServer } from "./app.js";
import { loadConfig } from "../config.js";

describe("buildServer", () => {
  it("GET /api/health 回 200 與 {ok:true}", async () => {
    const server = buildServer(loadConfig({}));
    const res = await server.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await server.close();
  });
});
