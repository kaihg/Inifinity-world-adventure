# TypeWriter 顯示 + TurnBuffer 斷線重連 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓前端文字以固定速度打字機效果呈現，並支援頁面重整或 tab 切換後自動重連仍在進行中的回合。

**Architecture:** 後端新增 `TurnBuffer`（in-memory）在回合進行期間累積所有事件；新增 `/api/turn/status` 與 `/api/turn/stream?offset=N` 端點供重連使用。前端改 delta 處理為推入 `pendingQueue`（ref），由 `setInterval`（25ms）以固定速度取字顯示，queue 過淺時 lookahead pause 等待緩衝。

**Tech Stack:** Node.js + TypeScript + Fastify（後端）、React + Vite（前端）、Vitest（測試）

## Global Constraints

- TypeScript strict mode，無 `any`
- 後端不引入新 npm 套件
- TurnBuffer 為 module-level mutable（server 內部狀態），不透過 `ServerDeps` 注入（測試用 `/api/turn` 測試 buffer 副作用即可）
- `TYPEWRITER_INTERVAL_MS = 25`，`LOOKAHEAD_MIN = 20`
- sessionStorage key：`"iwa_turnId"`、`"iwa_receivedOffset"`
- 測試指令：`cd app && npm test`

---

## File Map

**後端修改：**
- Modify: `app/src/server/app.ts` — 新增 `TurnBuffer`、在 `POST /api/turn` 寫入 buffer、新增 `GET /api/turn/status`、`GET /api/turn/stream`
- Modify: `app/src/server/app.test.ts` — 新增 TurnBuffer / 新端點測試

**前端修改：**
- Modify: `app/web/src/api.ts` — 新增 `fetchTurnStatus`、`streamTurnFromOffset`
- Modify: `app/web/src/App.tsx` — 改 delta 處理為 pendingQueue、TypeWriter interval、重連邏輯
- Modify: `app/web/src/App.test.tsx` — TypeWriter 邏輯 unit tests（純邏輯，不測動畫）

---

## Task 1：後端 TurnBuffer 資料結構與 POST /api/turn 整合

**Files:**
- Modify: `app/src/server/app.ts`
- Modify: `app/src/server/app.test.ts`

**Interfaces:**
- Produces: `TurnBuffer` interface（turnId, narrative, events, active）在 `app.ts` module scope

- [ ] **Step 1：在 `app.test.ts` 新增 TurnBuffer 副作用測試（先寫 failing test）**

在 `app/src/server/app.test.ts` 末尾加入新的 describe block：

```typescript
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
```

- [ ] **Step 2：執行測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose 2>&1 | grep -A3 "GET /api/turn/status"
```

期望：FAIL，`Cannot find /api/turn/status` 或 404 相關錯誤

- [ ] **Step 3：在 `app.ts` 加入 TurnBuffer 結構與 POST /api/turn 寫入邏輯**

在 `app/src/server/app.ts` 中，找到 `let turnInProgress = false;` 這行（約第 158 行），在其後加入：

```typescript
interface TurnBuffer {
  turnId: string;
  narrative: string;
  events: TurnEvent[];
  active: boolean;
}

let currentTurnBuffer: TurnBuffer | null = null;
```

然後在 `POST /api/turn` 的 `server.post("/api/turn", ...)` handler 中，找到 `turnInProgress = true;` 這行之後、`reply.hijack();` 之前，加入：

```typescript
currentTurnBuffer = { turnId, narrative: "", events: [], active: true };
```

在 `for await (const ev of gen)` 迴圈內，找到 `if (ev.type === "warning") ...` 之後，`if (ev.type === "done") { done = ev; continue; }` 之前，加入：

```typescript
if (ev.type === "delta") {
  currentTurnBuffer.narrative += ev.text;
}
currentTurnBuffer.events.push(ev);
```

在 `if (ev.type === "done") { done = ev; continue; }` 這行之後（`done` event 被截留），在 `reply.raw.write(...)` 轉發其他事件的那行同層，補上 `done` 也要寫進 buffer：

改原本的：
```typescript
if (ev.type === "done") { done = ev; continue; }
reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
```
為：
```typescript
if (ev.type === "done") {
  done = ev;
  currentTurnBuffer.events.push(ev);
  continue;
}
reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
```

注意：`done` 已在上面的通用 push 被加入，所以這裡實際上是把 `done` 的 push 移到截留點。改為：

```typescript
// 迴圈前初始化（已存在）
let done: Extract<TurnEvent, { type: "done" }> | null = null;
for await (const ev of gen) {
  if (ev.type === "warning") turnLogger.warn({ ev }, "回合警告事件");
  // 累積到 buffer（done 在截留後另外 push）
  if (ev.type !== "done" && currentTurnBuffer) {
    if (ev.type === "delta") currentTurnBuffer.narrative += ev.text;
    currentTurnBuffer.events.push(ev);
  }
  if (ev.type === "done") { done = ev; continue; }
  reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
}
```

在 `done` 確認後（`if (!done) { ... return; }` 之後）的轉場處理完、最後 `reply.raw.write done event` 之前，找到最後送出 done 事件的地方，在其前加入：

```typescript
if (currentTurnBuffer) {
  currentTurnBuffer.events.push(done);
  currentTurnBuffer.active = false;
}
```

- [ ] **Step 4：新增 GET /api/turn/status 端點**

在 `app.ts` 中，在 `server.post("/api/turn", ...)` 之前加入：

```typescript
server.get("/api/turn/status", async () => {
  return {
    active: currentTurnBuffer?.active ?? false,
    turnId: currentTurnBuffer?.turnId ?? null,
  };
});
```

- [ ] **Step 5：執行測試確認通過**

```bash
cd app && npm test -- --reporter=verbose 2>&1 | grep -A3 "GET /api/turn/status"
```

期望：PASS

- [ ] **Step 6：Commit**

```bash
git add app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(server): 新增 TurnBuffer 與 /api/turn/status 端點"
```

---

## Task 2：後端 GET /api/turn/stream 端點

**Files:**
- Modify: `app/src/server/app.ts`
- Modify: `app/src/server/app.test.ts`

**Interfaces:**
- Consumes: `currentTurnBuffer: TurnBuffer | null`（Task 1 產出）
- Produces: `GET /api/turn/stream?offset=N` SSE 端點

- [ ] **Step 1：新增 /api/turn/stream 測試**

在 Task 1 的 describe block 中補充測試：

```typescript
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
```

- [ ] **Step 2：執行測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose 2>&1 | grep -E "(PASS|FAIL|stream)"
```

期望：新增的 stream 測試 FAIL（端點不存在）

- [ ] **Step 3：實作 GET /api/turn/stream 端點**

在 `app.ts` 的 `GET /api/turn/status` 端點之後加入：

```typescript
server.get("/api/turn/stream", async (req, reply) => {
  const offsetParam = (req.query as { offset?: string }).offset;
  const offset = offsetParam !== undefined ? parseInt(offsetParam, 10) : 0;

  // buffer 不存在（伺服器重啟或從未有回合）
  if (!currentTurnBuffer) {
    return reply.code(204).send();
  }

  const buf = currentTurnBuffer;

  // offset 超出範圍（伺服器重啟後 buffer 清空，舊 offset 無效）
  if (offset > buf.events.length) {
    return reply.code(410).send({ error: "offset 超出 buffer 範圍，請重新整理" });
  }

  // 已完成且沒有新事件可送
  if (!buf.active && offset >= buf.events.length) {
    return reply.code(204).send();
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // 重播 offset 之後的事件
  for (let i = offset; i < buf.events.length; i++) {
    reply.raw.write(`data: ${JSON.stringify(buf.events[i])}\n\n`);
  }

  // 若回合已結束，直接關閉
  if (!buf.active) {
    reply.raw.end();
    return;
  }

  // 回合仍在進行：polling 等待新事件（每 100ms 檢查一次，最多等 5 分鐘）
  let cursor = buf.events.length;
  const maxWaitMs = 5 * 60 * 1000;
  const pollMs = 100;
  const deadline = Date.now() + maxWaitMs;

  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      // 送出新增的事件
      while (cursor < buf.events.length) {
        reply.raw.write(`data: ${JSON.stringify(buf.events[cursor])}\n\n`);
        cursor++;
      }
      // 回合結束或逾時，關閉串流
      if (!buf.active || Date.now() > deadline) {
        clearInterval(tick);
        reply.raw.end();
        resolve();
      }
    }, pollMs);
  });
});
```

- [ ] **Step 4：執行所有測試確認通過**

```bash
cd app && npm test -- --reporter=verbose 2>&1 | tail -20
```

期望：所有測試 PASS

- [ ] **Step 5：Commit**

```bash
git add app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(server): 新增 /api/turn/stream 重連端點"
```

---

## Task 3：前端 api.ts 新增 fetchTurnStatus 與 streamTurnFromOffset

**Files:**
- Modify: `app/web/src/api.ts`

**Interfaces:**
- Produces:
  - `fetchTurnStatus(): Promise<{ active: boolean; turnId: string | null }>`
  - `streamTurnFromOffset(offset: number, onEvent: (ev: TurnEvent) => void): Promise<void>`

- [ ] **Step 1：在 `api.ts` 加入兩個新函式**

在 `app/web/src/api.ts` 末尾（`resolveProtagonistDeath` 之後）加入：

```typescript
export async function fetchTurnStatus(): Promise<{ active: boolean; turnId: string | null }> {
  const res = await fetch("/api/turn/status");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/** 從指定 offset 重播已落地事件，並持續接收新事件直到串流結束 */
export async function streamTurnFromOffset(
  offset: number,
  onEvent: (ev: TurnEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/turn/stream?offset=${offset}`);
  if (res.status === 204) return; // 沒有需要重播的事件
  if (res.status === 410) throw new Error("GONE"); // buffer 已清，呼叫端降級處理
  if (!res.ok) throw new Error("HTTP " + res.status);
  if (!res.body) throw new Error("無回應串流");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.replace(/^data: /, "").trim();
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as TurnEvent);
      } catch {
        /* 忽略不完整片段 */
      }
    }
  }
}
```

- [ ] **Step 2：TypeScript 型別檢查**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```

期望：無錯誤

- [ ] **Step 3：Commit**

```bash
git add app/web/src/api.ts
git commit -m "feat(api): 新增 fetchTurnStatus 與 streamTurnFromOffset"
```

---

## Task 4：前端 TypeWriter 邏輯（pendingQueue + setInterval）

**Files:**
- Modify: `app/web/src/App.tsx`
- Modify: `app/web/src/App.test.tsx`

**Interfaces:**
- Consumes: `fetchTurnStatus`、`streamTurnFromOffset`（Task 3）

此 task 先實作 TypeWriter，重連邏輯在 Task 5 加入。

- [ ] **Step 1：在 `App.test.tsx` 新增 TypeWriter 邏輯測試**

TypeWriter 邏輯抽成純函式方便測試，先寫測試：

在 `app/web/src/App.test.tsx` 加入：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shouldTypewriterOutput } from "./App";

describe("shouldTypewriterOutput", () => {
  it("queue 充足時回 true", () => {
    expect(shouldTypewriterOutput({ queueLength: 25, llmDone: false })).toBe(true);
  });

  it("queue 不足且 LLM 未完成時回 false（lookahead pause）", () => {
    expect(shouldTypewriterOutput({ queueLength: 5, llmDone: false })).toBe(false);
  });

  it("LLM 完成後即使 queue 不足也回 true（排空 queue）", () => {
    expect(shouldTypewriterOutput({ queueLength: 5, llmDone: true })).toBe(true);
  });

  it("queue 為 0 且 LLM 完成 → 回 false（沒字可取）", () => {
    expect(shouldTypewriterOutput({ queueLength: 0, llmDone: true })).toBe(false);
  });
});
```

- [ ] **Step 2：執行測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose 2>&1 | grep -A5 "shouldTypewriterOutput"
```

期望：FAIL（`shouldTypewriterOutput` 未 export）

- [ ] **Step 3：在 `App.tsx` 加入 `shouldTypewriterOutput` 純函式並 export**

在 `App.tsx` 檔案頂部（import 之後、`COMPUTING_HINT` 常數之前）加入：

```typescript
export const TYPEWRITER_INTERVAL_MS = 25;
export const LOOKAHEAD_MIN = 20;

export function shouldTypewriterOutput({
  queueLength,
  llmDone,
}: {
  queueLength: number;
  llmDone: boolean;
}): boolean {
  if (queueLength === 0) return false;
  if (!llmDone && queueLength < LOOKAHEAD_MIN) return false;
  return true;
}
```

- [ ] **Step 4：執行測試確認通過**

```bash
cd app && npm test -- --reporter=verbose 2>&1 | grep -A5 "shouldTypewriterOutput"
```

期望：PASS

- [ ] **Step 5：改寫 App.tsx 的 delta 處理為 pendingQueue + TypeWriter**

在 `App()` 函式的 `const storyEndRef` 等 ref 宣告區塊中，加入新 ref：

```typescript
const pendingQueue = useRef<string[]>([]);
const llmDoneRef = useRef(false);
const typewriterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
```

新增 TypeWriter 啟動與停止的 helper（在 `App()` 函式內，`send` 函式之前）：

```typescript
function startTypewriter() {
  if (typewriterTimer.current) return;
  typewriterTimer.current = setInterval(() => {
    if (
      shouldTypewriterOutput({
        queueLength: pendingQueue.current.length,
        llmDone: llmDoneRef.current,
      })
    ) {
      const char = pendingQueue.current.shift()!;
      setStory((s) => s + char);
    } else if (llmDoneRef.current && pendingQueue.current.length === 0) {
      clearInterval(typewriterTimer.current!);
      typewriterTimer.current = null;
    }
  }, TYPEWRITER_INTERVAL_MS);
}

function stopTypewriter(clearQueue = false) {
  if (typewriterTimer.current) {
    clearInterval(typewriterTimer.current);
    typewriterTimer.current = null;
  }
  if (clearQueue) {
    pendingQueue.current = [];
  }
  llmDoneRef.current = false;
}
```

修改 `send` 函式中的 `streamTurn` 回呼，將 `delta` 的處理改為推入 queue：

將原本的：
```typescript
case "delta":
  setStory((s) => s + ev.text);
  break;
```
改為：
```typescript
case "delta":
  for (const char of ev.text) {
    pendingQueue.current.push(char);
  }
  startTypewriter();
  break;
```

在 `send` 函式開頭（`setStory("")` 之後、`streamTurn` 之前）加入 TypeWriter 重置：

```typescript
stopTypewriter(true);
llmDoneRef.current = false;
```

在 `done` event 的 `case "done":` 處理結尾加入：

```typescript
llmDoneRef.current = true;
```

在 `send` 的 `catch` 區塊（`setStory((s) => s + "\n[請求失敗]...")` 之前）加入：

```typescript
stopTypewriter(true);
```

在 `send` 的 error event 處理加入停止：

將原本的：
```typescript
case "error":
  setStory((s) => s + `\n[錯誤] ${ev.message}\n`);
  break;
```
改為：
```typescript
case "error":
  stopTypewriter(true);
  setStory((s) => s + `\n[錯誤] ${ev.message}\n`);
  break;
```

- [ ] **Step 6：執行全部測試確認無 regression**

```bash
cd app && npm test 2>&1 | tail -10
```

期望：所有測試 PASS

- [ ] **Step 7：Commit**

```bash
git add app/web/src/App.tsx app/web/src/App.test.tsx
git commit -m "feat(frontend): TypeWriter pendingQueue + lookahead pause"
```

---

## Task 5：前端重連邏輯（visibilitychange + load）

**Files:**
- Modify: `app/web/src/App.tsx`

**Interfaces:**
- Consumes: `fetchTurnStatus`、`streamTurnFromOffset`（Task 3）、`startTypewriter`、`stopTypewriter`、`llmDoneRef`、`pendingQueue`（Task 4）

- [ ] **Step 1：在 `App.tsx` 新增 sessionStorage helpers**

在 `App()` 函式內、`send` 函式之前加入：

```typescript
const SESSION_TURN_ID_KEY = "iwa_turnId";
const SESSION_OFFSET_KEY = "iwa_receivedOffset";

function saveReconnectState(turnId: string, offset: number) {
  sessionStorage.setItem(SESSION_TURN_ID_KEY, turnId);
  sessionStorage.setItem(SESSION_OFFSET_KEY, String(offset));
}

function loadReconnectState(): { turnId: string; offset: number } | null {
  const turnId = sessionStorage.getItem(SESSION_TURN_ID_KEY);
  const offsetStr = sessionStorage.getItem(SESSION_OFFSET_KEY);
  if (!turnId || offsetStr === null) return null;
  return { turnId, offset: parseInt(offsetStr, 10) };
}

function clearReconnectState() {
  sessionStorage.removeItem(SESSION_TURN_ID_KEY);
  sessionStorage.removeItem(SESSION_OFFSET_KEY);
}
```

- [ ] **Step 2：在 `send` 函式標記「回合進行中」供重連偵測用**

設計決策：sessionStorage 只儲存 `iwa_turnId`（目前正在跑的回合 ID），不儲存 offset。重連時固定從 offset=0 重播 buffer 全部事件——因為 buffer 保留完整序列，重播全部既正確又簡單。

在 `send` 函式的 `try {` 之後（`setStory("")` 之後）加入，取得本回合 turnId（需先 fetch status）：

```typescript
// 標記本回合 ID 供重連使用，非同步取得不阻塞
fetchTurnStatus().then((s) => {
  if (s.turnId) sessionStorage.setItem(SESSION_TURN_ID_KEY, s.turnId);
}).catch(() => {});
```

在 `send` 的 `await refresh()` 之後（回合正常完成）加入：

```typescript
clearReconnectState();
```

在 `send` 的 `catch` 區塊，`stopTypewriter(true)` 之後加入：

```typescript
clearReconnectState();
```

- [ ] **Step 3：新增 `reconnectIfNeeded` 函式**

在 `App()` 函式內、`send` 之前加入：

```typescript
async function reconnectIfNeeded() {
  if (busyRef.current) return; // 正在執行回合，不重連
  try {
    const status = await fetchTurnStatus();
    if (!status.active) {
      // 回合已完成，走現有 fetchState() 還原路徑
      return;
    }
    // 回合仍在進行中
    setBusy(true);
    setStory("");
    setSuggested([]);
    const offset = 0; // 固定從 0 重播 buffer 全部事件（buffer 保留完整序列）

    let receivedEventCount = offset;
    try {
      await streamTurnFromOffset(offset, (ev) => {
        receivedEventCount++;
        switch (ev.type) {
          case "delta":
            for (const char of ev.text) {
              pendingQueue.current.push(char);
            }
            startTypewriter();
            break;
          case "transition":
            setStory(
              (s) =>
                s + `\n\n【${ev.to === "dungeon" ? `進入副本 ${ev.dungeonId ?? ""}` : "返回安全區"}】\n\n`,
            );
            setSuggested([]);
            break;
          case "warning":
            setStory((s) => s + `\n[提示] ${ev.message}\n`);
            break;
          case "error":
            stopTypewriter(true);
            setStory((s) => s + `\n[錯誤] ${ev.message}\n`);
            break;
          case "done":
            if (ev.protagonistDied) {
              setProtagonistDied(true);
              setSuggested([]);
            } else if (ev.awaitingUserInput) {
              setSuggested(ev.suggestedActions ?? []);
            } else {
              setSuggested([]);
            }
            if (ev.state) setState(ev.state);
            llmDoneRef.current = true;
            break;
        }
      });
      await refresh();
      clearReconnectState();
    } catch (e) {
      if (e instanceof Error && e.message === "GONE") {
        // buffer 已清（伺服器重啟），降級還原最後已落地回合
        await refresh();
        setStory((s) => s || "連線已中斷，已還原最後進度。");
      } else {
        setStory((s) => s + `\n[重連失敗] ${(e as Error).message}\n`);
      }
    } finally {
      setBusy(false);
    }
  } catch {
    // fetchTurnStatus 失敗，靜默忽略（網路問題，不影響現有流程）
  }
}
```

- [ ] **Step 4：修改 visibilitychange 與初始 load 邏輯**

找到現有的 `useEffect` 中的 `handleVisibility` 函式：

```typescript
const handleVisibility = () => {
  if (document.visibilityState === "visible") {
    fetchState()
      .then((s) => {
        if (!busyRef.current) {
          setState(s);
          if (s.lastTurn) {
            setStory(s.lastTurn.narrative);
            setSuggested(s.lastTurn.suggestedActions);
          }
        }
      })
      .catch(() => {});
  }
};
```

改為：

```typescript
const handleVisibility = () => {
  if (document.visibilityState === "visible") {
    reconnectIfNeeded().catch(() => {});
    // 無論是否重連，也補一次 fetchState 更新 sidebar 狀態
    if (!busyRef.current) {
      fetchState()
        .then((s) => {
          setState(s);
          if (s.lastTurn && !busyRef.current) {
            setStory(s.lastTurn.narrative);
            setSuggested(s.lastTurn.suggestedActions);
          }
        })
        .catch(() => {});
    }
  }
};
```

在 `useEffect` 的初始化部分（`refresh()` 之後）加入：

```typescript
reconnectIfNeeded().catch(() => {});
```

- [ ] **Step 5：TypeScript 型別檢查**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```

期望：無錯誤

- [ ] **Step 6：執行全部測試確認無 regression**

```bash
cd app && npm test 2>&1 | tail -10
```

期望：所有測試 PASS

- [ ] **Step 7：Commit**

```bash
git add app/web/src/App.tsx
git commit -m "feat(frontend): 頁面重整/visibility change 自動重連 TurnBuffer"
```

---

## Task 6：手動驗證與收尾

**Files:**
- 無需修改（驗收用）

- [ ] **Step 1：啟動 dev server**

```bash
cd app && cp .env.example .env  # 若尚未建立
# 編輯 .env 填入 OPENAI_BASE_URL / OPENAI_API_KEY / MODEL
npm run dev
# 後端 http://localhost:5173，前端 http://localhost:5174
```

- [ ] **Step 2：驗證 TypeWriter 效果**

開 http://localhost:5174，輸入任意行動送出。
- 確認文字以均勻速度逐字打出，不是瞬間全出現也不是 stutter
- 觀察 LLM 開始吐字前有 lookahead pause（cursor blinking，約等 20 字 buffer 後才開始顯示）

- [ ] **Step 3：驗證重連（回合進行中重整）**

1. 送出行動，看到文字開始打出
2. **立即**重整頁面（Cmd+R）
3. 預期：頁面重整後自動重連，從中斷位置繼續顯示文字（可能有短暫空白，但文字應續出）

- [ ] **Step 4：驗證重連（回合已完成重整）**

1. 送出行動，等回合完整結束（出現建議行動 chips）
2. 重整頁面
3. 預期：還原最後一回合敘事，建議行動 chips 顯示

- [ ] **Step 5：驗證切換 tab（visibilitychange）**

1. 送出行動
2. 切換到其他 tab，等待一段時間
3. 切回遊戲 tab
4. 預期：若回合完成，顯示最新狀態；若回合還在跑（自架模型慢），重連繼續

- [ ] **Step 6：最終 commit（若有小調整）**

```bash
git add -p  # 選擇性加入調整
git commit -m "fix(frontend): 手動驗證後細節調整"
```
