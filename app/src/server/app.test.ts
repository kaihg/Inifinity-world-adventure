import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "./app.js";
import { loadConfig } from "../config.js";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { isWorldInitialized } from "../engine/world-status.js";

function fakeClient(deltas: string[]): LlmClient {
  return {
    async *streamChat(_m: ChatMessage[]): AsyncIterable<string> {
      for (const d of deltas) yield d;
    },
  };
}

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

  it("GET /api/state 含 protagonistDetail 與 npcs", async () => {
    const server = buildServer(loadConfig({}));
    const res = await server.inject({ method: "GET", url: "/api/state" });
    const body = res.json();
    expect(body.protagonistDetail).toBeDefined();
    expect(Array.isArray(body.npcs)).toBe(true);
    await server.close();
  });
});

describe("POST /api/turn（SSE）", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-route-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 設定\n禁止竄改數值。\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 進行中的副本：無\n- 最後更新：[2026-06-18] 舊\n",
    );
    await writeFile(
      path.join(world, "characters", "protagonist.md"),
      "- 姓名：沈奕\n- 當前積分：0\n",
    );
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("以 SSE 串流 delta 與 done 事件", async () => {
    const commits: string[] = [];
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["前半段，", "後半段。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "看看四周",
        }),
      ]),
      commit: async (m) => { commits.push(m); return true; },
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/turn",
      payload: { input: "我四處看看" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('"type":"delta"');
    expect(res.body).toContain("前半段");
    expect(res.body).toContain('"type":"done"');
    expect(commits).toHaveLength(1);
    await server.close();
  });

  it("loreClient 卡住也不影響 SSE response 關閉（Layer 3 不卡 Layer 2 完成）", async () => {
    const stuckLoreClient: LlmClient = {
      async *streamChat() {
        await new Promise(() => {}); // 永遠不 resolve，模擬掛掉/超慢的 Layer 3 LLM
      },
    };
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["前半段，", "後半段。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "看看四周",
        }),
      ]),
      loreClient: stuckLoreClient,
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/turn",
      payload: { input: "我四處看看" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"done"');
    await server.close();
  });
});

describe("GET /api/world/status", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-status-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("setting.md 不存在 → initialized:false", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }));
    const res = await server.inject({ method: "GET", url: "/api/world/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initialized: false });
    await server.close();
  });

  it("setting.md 有正常內容 → initialized:true", async () => {
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n真實世界。\n", "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }));
    const res = await server.inject({ method: "GET", url: "/api/world/status" });
    expect(res.json()).toEqual({ initialized: true });
    await server.close();
  });
});

describe("POST /api/world/init", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-init-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    // 未初始化：不寫 setting.md
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("未初始化時成功生成世界，回 GameState，setting.md 變成正常內容", async () => {
    const commits: string[] = [];
    // init 內部依序呼叫 client 三次：setting / gm-notes / protagonist
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["# 世界設定\n\n冷酷系統。\n"]),
      commit: async (m) => { commits.push(m); return true; },
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/world/init",
      payload: { preferences: {}, protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.now).toBeDefined();
    expect(await isWorldInitialized(world)).toBe(true);
    expect(commits).toHaveLength(1);
    await server.close();
  });

  it("已初始化時回 409，不動檔案", async () => {
    await writeFile(path.join(world, "setting.md"), "# 已存在世界\n\n內容。\n", "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["不該被呼叫"]),
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/world/init",
      payload: { preferences: {}, protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});
