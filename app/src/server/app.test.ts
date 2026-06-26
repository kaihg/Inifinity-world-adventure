import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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

function parseSSEEvents(body: string): any[] {
  return body
    .split("\n\n")
    .map((chunk) => chunk.replace(/^data: /, "").trim())
    .filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

describe("buildServer", () => {
  // 用隔離的 temp 世界，不讀線上 ./world（否則封存重置後線上 world 變佔位狀態會害這些測試掛）
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-buildserver-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(
      path.join(world, "setting.md"),
      "# 世界設定（World Setting）\n\n真實世界。\n",
      "utf8",
    );
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 進行中的副本：無\n- 最後更新：[2026-06-18] 測試\n",
      "utf8",
    );
    await writeFile(
      path.join(world, "characters", "protagonist.md"),
      "- 姓名：沈奕\n- 當前積分：0\n",
      "utf8",
    );
    await writeFile(path.join(world, "characters", "index.md"), "| ID | 姓名 |\n", "utf8");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("GET /api/health 回 200 與 {ok:true}", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }));
    const res = await server.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    await server.close();
  });

  it("GET /api/state 回傳當前局勢、主角摘要與模式", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }));
    const res = await server.inject({ method: "GET", url: "/api/state" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.now.chapter).not.toBe("");
    expect(body.protagonist.name).toBe("沈奕");
    expect(["main-space", "dungeon"]).toContain(body.mode);
    await server.close();
  });

  it("GET / 回傳 HTML 頁面", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }));
    const res = await server.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("無限世界冒險");
    await server.close();
  });

  it("GET /api/state 含 protagonistDetail 與 npcs", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }));
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

  it("pacingClient 注入後，行數達門檻時建議內容出現在串流敘事前的 system prompt（透過 done 事件確認回合正常完成）", async () => {
    await writeFile(path.join(world, "journal_summary.md"), "- [2026-06-19T09:00:00] (主空間) 之前的事\n");
    const server = buildServer(loadConfig({ WORLD_DIR: world, PACING_REVIEW_INTERVAL: "1" }), {
      client: fakeClient(["前半段，", "後半段。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "看看四周",
        }),
      ]),
      pacingClient: fakeClient(["該開新副本了。"]),
      commit: async () => true,
    });
    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "我四處看看" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"done"');
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

  it("一回合（含自動推進）仍在執行時，第二個 /api/turn 請求回 409，不會並發寫 world/", async () => {
    let releaseFirst: () => void = () => {};
    const blockingClient: LlmClient = {
      async *streamChat() {
        yield "前半段，";
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        yield "後半段。";
      },
    };
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: blockingClient,
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "看看四周",
        }),
      ]),
      commit: async () => true,
    });

    const firstReq = server.inject({ method: "POST", url: "/api/turn", payload: { input: "我四處看看" } });
    // 讓第一個請求先進入 hijack/streamChat，確保鎖已被設置
    await new Promise((resolve) => setTimeout(resolve, 10));

    const secondRes = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "再四處看看" } });
    expect(secondRes.statusCode).toBe(409);

    releaseFirst();
    const firstRes = await firstReq;
    expect(firstRes.statusCode).toBe(200);
    await server.close();
  });

  it("suggestedActions 為空時，done 事件補「順勢而為」", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["敘事。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "回合",
        }),
      ]),
      commit: async () => true,
    });
    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "等待" } });
    expect(res.statusCode).toBe(200);
    const events = parseSSEEvents(res.body);
    const done = events.find((e: any) => e.type === "done");
    expect(done?.suggestedActions).toEqual(["順勢而為"]);
    await server.close();
  });

  it("suggestedActions 非空時，不補順勢而為", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["敘事。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: ["拔刀", "躲避"], commit_summary: "回合",
        }),
      ]),
      commit: async () => true,
    });
    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "等待" } });
    expect(res.statusCode).toBe(200);
    const events = parseSSEEvents(res.body);
    const done = events.find((e: any) => e.type === "done");
    expect(done?.suggestedActions).toEqual(["拔刀", "躲避"]);
    await server.close();
  });

  it("enter_dungeon 轉場後即停，不繼續執行下一回合", async () => {
    const enterCtl = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: "enter_dungeon",
      transition_dungeon_id: "D-001", transition_dungeon_goal: "找到鑰匙",
      awaiting_user_input: false, suggested_actions: [], commit_summary: "系統開啟副本",
    });
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["系統警報響起。", "這個副本的機關是洪水。"]),
      controlClient: fakeClient([enterCtl, enterCtl]),  // Layer 2 + Layer 3
      commit: async () => true,
    });
    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "在安全區等待" } });
    expect(res.statusCode).toBe(200);
    const events = parseSSEEvents(res.body);
    const transitions = events.filter((e: any) => e.type === "transition");
    const dones = events.filter((e: any) => e.type === "done");
    // 轉場後即停，只有一個 transition 與一個 done
    expect(transitions).toHaveLength(1);
    expect(dones).toHaveLength(1);
    expect(transitions[0].to).toBe("dungeon");
    // 轉場後合成的 done 要有 fallback 按鈕
    expect(dones[0].suggestedActions).toEqual(["順勢而為"]);
    await server.close();
  });

  it("enter_dungeon guard（缺 dungeonId）後 now.md nextStep 寫成過渡狀態", async () => {
    // mode_transition=enter_dungeon 但沒有 transition_dungeon_id → 觸發 guard
    const guardCtl = JSON.stringify({
      state_changes: { now: { nextStep: "主角即將進入副本，虛空傳送中" } },
      rolls: [], mode_transition: "enter_dungeon",
      // 故意不給 transition_dungeon_id
      awaiting_user_input: true, suggested_actions: [], commit_summary: "觸發傳送",
    });
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["系統強制傳送。"]),
      controlClient: fakeClient([guardCtl, guardCtl]),
      commit: async () => true,
    });

    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "等待" } });
    expect(res.statusCode).toBe(200);

    // 確認 now.md 的 nextStep 被覆寫為過渡語氣
    const nowMd = await readFile(path.join(world, "now.md"), "utf8");
    expect(nowMd).toContain("傳送中（副本目標定位中）");
    await server.close();
  });

  it("settle_dungeon 轉場後 done.state.mode 為 main-space", async () => {
    // 先建立副本狀態的 now.md
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 進行中的副本：D-001 + run-1\n- 最後更新：[2026-06-26] 測試\n",
    );
    // 建立副本目錄與 log.md（settle_dungeon 會嘗試 rename）
    const dungeonDir = path.join(world, "dungeons", "D-001");
    await mkdir(dungeonDir, { recursive: true });
    await writeFile(path.join(dungeonDir, "log.md"), "# 副本 D-001 · run-1（2026-06-26）\n\n---\n\n");

    const settleCtl = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: "settle_dungeon",
      awaiting_user_input: true, suggested_actions: [], commit_summary: "副本結算",
    });
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["副本結算完成。"]),
      controlClient: fakeClient([settleCtl, settleCtl]), // Layer 2 + Layer 3 各一份
      commit: async () => true,
    });

    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "撤退" } });
    expect(res.statusCode).toBe(200);
    const events = parseSSEEvents(res.body);
    const done = events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();

    // settle_dungeon 轉場後 done.state.mode 必須是 main-space
    expect(done.state?.mode).toBe("main-space");
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
    // 建 repoRoot/world/ 結構（initWorld 需要 repoRoot/templates/）
    const repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-init-repo-"));
    world = path.join(repoRoot, "world");
    await mkdir(path.join(world, "characters"), { recursive: true });
    // 建全域骨架（最小版，供 getTemplate fallback）
    await mkdir(path.join(repoRoot, "templates"), { recursive: true });
    await writeFile(path.join(repoRoot, "templates", "setting.md"), "# 世界設定（World Setting）\n\n## 主控系統\n<!-- 填入 -->\n", "utf8");
    await writeFile(path.join(repoRoot, "templates", "character.md"), "# 主角檔案\n\n## 基本資訊\n<!-- 填入 -->\n", "utf8");
    await writeFile(path.join(repoRoot, "templates", "opening.md"), "# 開場敘事\n\n## 必須涵蓋\n<!-- 填入 -->\n", "utf8");
    // 未初始化：不寫 setting.md
  });
  afterEach(async () => {
    await rm(path.dirname(world), { recursive: true, force: true });
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

  it("有設定 LORE_MODEL 時，世界初始化改用 lore 的 model（不沿用主 client）：lore 生成的內容應落地", async () => {
    const throwingMainClient: LlmClient = {
      async *streamChat() {
        throw new Error("不該呼叫主 client：初始化應改用 lore 的 model");
      },
    };
    const server = buildServer(
      loadConfig({
        WORLD_DIR: world,
        LORE_OPENAI_BASE_URL: "http://lore-endpoint/v1",
        LORE_MODEL: "lore-model",
      }),
      {
        client: throwingMainClient,
        initClient: fakeClient(["# 世界設定\n\n用 lore model 生成。\n"]),
        commit: async () => true,
      },
    );
    const res = await server.inject({
      method: "POST",
      url: "/api/world/init",
      payload: { preferences: {}, protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(await isWorldInitialized(world)).toBe(true);
    const setting = await readFile(path.join(world, "setting.md"), "utf8");
    expect(setting).toContain("用 lore model 生成");
    await server.close();
  });

  it("沒設定 LORE_MODEL 時，世界初始化退回主 client", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["# 世界設定\n\n主 client 生成。\n"]),
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/world/init",
      payload: { preferences: {}, protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(200);
    const setting = await readFile(path.join(world, "setting.md"), "utf8");
    expect(setting).toContain("主 client 生成");
    await server.close();
  });

  it("LLM 失敗時回 500、不 commit、不留半套世界檔案", async () => {
    const commits: string[] = [];
    const throwingClient: LlmClient = {
      async *streamChat() { throw new Error("LLM 連線失敗"); },
    };
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: throwingClient,
      commit: async (m) => { commits.push(m); return true; },
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/world/init",
      payload: { preferences: {}, protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: expect.any(String) });
    expect(await isWorldInitialized(world)).toBe(false);
    expect(commits).toHaveLength(0);
    await server.close();
  });
});

describe("POST /api/world/end", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-end-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n真實世界。\n", "utf8");
    await writeFile(path.join(world, "gm-notes.md"), "# 隱藏真相\n\n秘密。\n", "utf8");
    await writeFile(path.join(world, "now.md"), "- 當前篇章：終章\n- 進行中的副本：無\n- 最後更新：[2026-06-23] x\n", "utf8");
    await writeFile(path.join(world, "journal.md"), "# 日誌\n\n劇情。\n", "utf8");
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n", "utf8");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("confirmText 不符 → 400，不動世界", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), { client: fakeClient(["摘要"]) });
    const res = await server.inject({
      method: "POST", url: "/api/world/end", payload: { confirmText: "刪除" },
    });
    expect(res.statusCode).toBe(400);
    expect(await isWorldInitialized(world)).toBe(true);
    await server.close();
  });

  it("confirmText 為「封存」→ 封存並重置 setting.md 回佔位狀態", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["這是故事的終章摘要。"]),
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/world/end", payload: { confirmText: "封存" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedTo).toMatch(/^archives\//);
    expect(await isWorldInitialized(world)).toBe(false);
    await server.close();
  });

  it("world/.pending-death 存在時 → 409（先走死亡抉擇）", async () => {
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }), { client: fakeClient(["摘要"]) });
    const res = await server.inject({
      method: "POST", url: "/api/world/end", payload: { confirmText: "封存" },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});

describe("POST /api/world/protagonist", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-prot-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n真實世界。\n", "utf8");
    await writeFile(path.join(world, "gm-notes.md"), "# 隱藏真相\n\n秘密。\n", "utf8");
    await writeFile(path.join(world, "now.md"), "- 當前篇章：終章\n- 進行中的副本：無\n- 最後更新：[2026-06-23] x\n", "utf8");
    await writeFile(path.join(world, "journal.md"), "# 日誌\n\n舊主角劇情。\n", "utf8");
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n", "utf8");
    await writeFile(path.join(world, "characters", "index.md"), "| ID | 姓名 |\n| protagonist | 沈奕 |\n", "utf8");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("無 .pending-death → 409", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), { client: fakeClient(["x"]) });
    const res = await server.inject({
      method: "POST", url: "/api/world/protagonist",
      payload: { choice: "keep-world", protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it("keep-world：封存舊主角檔（含 now.md）、生成新主角、刪 .pending-death、保留 setting/gm-notes", async () => {
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
    const settingBefore = await readFile(path.join(world, "setting.md"), "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["# 主角檔案\n- 姓名：新主角\n- 當前積分：0\n"]),
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/world/protagonist",
      payload: { choice: "keep-world", protagonistSeed: { name: "新主角" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().now).toBeDefined();
    // setting/gm-notes 不動
    expect(await readFile(path.join(world, "setting.md"), "utf8")).toBe(settingBefore);
    // .pending-death 已刪
    await expect(readFile(path.join(world, ".pending-death"), "utf8")).rejects.toThrow();
    await server.close();
  });

  it("end-world：等同封存（免 confirmText），切回未初始化，刪 .pending-death", async () => {
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["終章摘要。"]),
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/world/protagonist", payload: { choice: "end-world" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedTo).toMatch(/^archives\//);
    expect(await isWorldInitialized(world)).toBe(false);
    await expect(readFile(path.join(world, ".pending-death"), "utf8")).rejects.toThrow();
    await server.close();
  });
});

describe("POST /api/turn 玩家決策記錄", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-turn-decision-"));
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

  it("POST /api/turn 會在主回合開始前記錄玩家原始輸入", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["前半段，", "後半段。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "確認出口",
        }),
      ]),
      commit: async () => true,
    });
    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "先確認出口" } });
    expect(res.statusCode).toBe(200);
    const decisionsContent = await readFile(path.join(world, "player-decisions.md"), "utf8");
    expect(decisionsContent).toContain("先確認出口");
    await server.close();
  });
});

describe("TurnBuffer：POST /api/turn 填充 buffer", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-buffer-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 設定\n\n世界。\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 進行中的副本：無\n- 最後更新：[2026-06-26] 測試\n",
    );
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("回合完成後 GET /api/turn/status 回 active:false、turnId 不為 null", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["敘事內容。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "回合",
        }),
      ]),
      commit: async () => true,
    });
    await server.inject({ method: "POST", url: "/api/turn", payload: { input: "行動" } });
    const res = await server.inject({ method: "GET", url: "/api/turn/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.active).toBe(false);
    expect(typeof body.turnId).toBe("string");
    expect(body.turnId).not.toBe("");
    await server.close();
  });
});

describe("GET /api/turn/stream 重連端點", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-stream-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 設定\n\n世界。\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 進行中的副本：無\n- 最後更新：[2026-06-26] 測試\n",
    );
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("GET /api/turn/stream?offset=0 重播所有已落地事件，active=false 時串流結束", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["abc", "def"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: ["行動A"], commit_summary: "回合",
        }),
      ]),
      commit: async () => true,
    });
    await server.inject({ method: "POST", url: "/api/turn", payload: { input: "行動" } });
    const res = await server.inject({ method: "GET", url: "/api/turn/stream?offset=0" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const events = parseSSEEvents(res.body);
    const deltas = events.filter((e: any) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);
    const done = events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();
    await server.close();
  });

  it("GET /api/turn/stream?offset=N 超出 buffer 長度 → 410", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["x"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "回合",
        }),
      ]),
      commit: async () => true,
    });
    await server.inject({ method: "POST", url: "/api/turn", payload: { input: "行動" } });
    // 超出實際 events 長度
    const res = await server.inject({ method: "GET", url: "/api/turn/stream?offset=9999" });
    expect(res.statusCode).toBe(410);
    await server.close();
  });

  it("沒有進行中的回合（buffer 為 null）→ GET /api/turn/stream 回 204", async () => {
    // 全新 server，未觸發任何回合
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient([]),
      commit: async () => true,
    });
    const res = await server.inject({ method: "GET", url: "/api/turn/stream?offset=0" });
    expect(res.statusCode).toBe(204);
    await server.close();
  });

  it("enter_dungeon 轉場後重連（offset=0）可看到 transition 事件", async () => {
    const enterCtl = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: "enter_dungeon",
      transition_dungeon_id: "D-001", transition_dungeon_goal: "找到鑰匙",
      awaiting_user_input: false, suggested_actions: [], commit_summary: "系統開啟副本",
    });
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["系統警報響起。"]),
      controlClient: fakeClient([enterCtl, enterCtl]),
      commit: async () => true,
    });

    // 先完成一個有轉場的回合
    await server.inject({ method: "POST", url: "/api/turn", payload: { input: "等待" } });

    // 重連，從 offset=0 重播
    const res = await server.inject({ method: "GET", url: "/api/turn/stream?offset=0" });
    expect(res.statusCode).toBe(200);
    const events = parseSSEEvents(res.body);
    const transitions = events.filter((e: any) => e.type === "transition");

    // 重播的事件裡必須包含 transition
    expect(transitions).toHaveLength(1);
    expect(transitions[0].to).toBe("dungeon");
    expect(transitions[0].dungeonId).toBe("D-001");
    await server.close();
  });

  it("enter_dungeon 轉場後 done.state.mode 為 dungeon", async () => {
    const enterCtl = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: "enter_dungeon",
      transition_dungeon_id: "D-002", transition_dungeon_goal: "目標",
      awaiting_user_input: true, suggested_actions: [], commit_summary: "進副本",
    });
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["敘事。"]),
      controlClient: fakeClient([enterCtl, enterCtl]),
      commit: async () => true,
    });

    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "行動" } });
    expect(res.statusCode).toBe(200);
    const events = parseSSEEvents(res.body);
    const done = events.find((e: any) => e.type === "done");
    expect(done).toBeDefined();

    // 轉場後 done.state.mode 必須是 dungeon（不是轉場前的 main-space）
    expect(done.state?.mode).toBe("dungeon");
    await server.close();
  });

  it("settle_dungeon 轉場後重連（offset=0）可看到 transition 事件", async () => {
    // 先建立副本狀態的 now.md
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 進行中的副本：D-001 + run-1\n- 最後更新：[2026-06-26] 測試\n",
    );
    // 建立副本目錄與 log.md（settle_dungeon 會嘗試 rename）
    const dungeonDir = path.join(world, "dungeons", "D-001");
    await mkdir(dungeonDir, { recursive: true });
    await writeFile(path.join(dungeonDir, "log.md"), "# 副本 D-001 · run-1（2026-06-26）\n\n---\n\n");

    const settleCtl = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: "settle_dungeon",
      awaiting_user_input: true, suggested_actions: [], commit_summary: "副本結算",
    });
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["副本結算完成。"]),
      controlClient: fakeClient([settleCtl, settleCtl]), // Layer 2 + Layer 3 各一份
      commit: async () => true,
    });

    await server.inject({ method: "POST", url: "/api/turn", payload: { input: "撤退" } });

    const res = await server.inject({ method: "GET", url: "/api/turn/stream?offset=0" });
    expect(res.statusCode).toBe(200);
    const events = parseSSEEvents(res.body);
    const transitions = events.filter((e: any) => e.type === "transition");

    expect(transitions).toHaveLength(1);
    expect(transitions[0].to).toBe("main-space");
    await server.close();
  });
});

describe("POST /api/world/protagonist — 主角結算整合", () => {
  let world: string;
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-prot-settle-"));
    world = path.join(repoRoot, "world");
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n真實世界。\n", "utf8");
    await writeFile(path.join(world, "gm-notes.md"), "# 隱藏真相\n\n秘密。\n", "utf8");
    await writeFile(path.join(world, "now.md"), "- 當前篇章：終章\n- 進行中的副本：無\n- 最後更新：[2026-06-23] x\n", "utf8");
    await writeFile(path.join(world, "journal.md"), "# 主空間日誌（Journal）\n\n## [2026-06-23] 舊日誌\n\n舊主角的冒險。\n", "utf8");
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n", "utf8");
    await writeFile(path.join(world, "characters", "index.md"), "| ID | 姓名 |\n| protagonist | 沈奕 |\n", "utf8");
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("end-world：結算主角（已結算主角代數 1）且封存世界（已封存世界數 1）", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["終章摘要。"]),
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/world/protagonist", payload: { choice: "end-world" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedTo).toMatch(/^archives\//);
    const playerMd = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(playerMd).toContain("已結算主角代數：1");
    expect(playerMd).toContain("已封存世界數：1");
    await server.close();
  });
});

describe("POST /api/turn 在 .pending-death 存在時擋下", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-turn-block-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 設定\n", "utf8");
    await writeFile(path.join(world, "now.md"), "- 當前篇章：第一章\n- 進行中的副本：無\n- 最後更新：[2026-06-18] 舊\n", "utf8");
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n", "utf8");
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("回 error event，不呼叫 client.streamChat", async () => {
    let called = false;
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: { async *streamChat() { called = true; yield "x"; } },
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/turn", payload: { input: "行動" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"error"');
    expect(res.body).toContain("主角已死亡");
    expect(called).toBe(false);
    await server.close();
  });
});
