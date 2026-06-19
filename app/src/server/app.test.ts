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

  it("GET /api/state 回傳當前局勢、主角摘要與模式", async () => {
    const server = buildServer(loadConfig({}));
    const res = await server.inject({ method: "GET", url: "/api/state" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.now.chapter).not.toBe("");
    expect(body.protagonist.name).toBe("沈奕");
    expect(["main-space", "dungeon"]).toContain(body.mode);
    await server.close();
  });

  it("GET / 回傳 HTML 頁面", async () => {
    const server = buildServer(loadConfig({}));
    const res = await server.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("無限世界冒險");
    await server.close();
  });
});
