# 副本轉場狀態修正（Issue #51 Bug 1-3）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正副本轉場的三個具體 bug：transition 事件不進 buffer（重連漏事件）、done.state 是轉場前舊快照、guard 擋下時 now.md 與實際 mode 脫鈎。

**Architecture:** 所有改動集中在 `app/src/server/app.ts` 的轉場處理區塊（第 452-487 行），補加三個 import，不動 `turn-core.ts` 或其他模組。

**Tech Stack:** Node.js + TypeScript + Vitest（測試），Fastify（HTTP）

## Global Constraints

- 只改 `app/src/server/app.ts` 與 `app/src/server/app.test.ts`
- 不動 `turn-core.ts`，不動任何 engine/ 模組
- 降級行為（catch）只 warn，不讓回合崩潰
- 測試使用 `fakeClient` 注入假 LLM 回應，不真正呼叫外部 API
- 執行測試：`cd app && npm test`

---

### Task 1：Bug 1 — transition 事件進 buffer

**Files:**
- Modify: `app/src/server/app.ts:474`（enter_dungeon 的 transition write）
- Modify: `app/src/server/app.ts:485`（settle_dungeon 的 transition write）
- Test: `app/src/server/app.test.ts`

**Interfaces:**
- Produces: `transition` 事件進 `currentTurnBuffer.events`，重連端點 `/api/turn/stream?offset=0` 可重播

- [ ] **Step 1：寫失敗測試**

在 `app/src/server/app.test.ts` 的 `describe("GET /api/turn/stream 重連端點")` 區塊末尾新增：

```typescript
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
```

- [ ] **Step 2：執行測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose app/src/server/app.test.ts
```

預期：新測試 FAIL（`transitions` 長度為 0，因為 buffer 沒有 transition 事件）

- [ ] **Step 3：修改 `app.ts`，讓 transition 事件進 buffer**

找到 `app/src/server/app.ts` 的兩處 `reply.raw.write(transition...)`，改為先建物件再 push：

```typescript
// enter_dungeon（原本的 app.ts:474）
const enterTransEv = { type: "transition", to: "dungeon", dungeonId: active.dungeonId } as const;
if (currentTurnBuffer) currentTurnBuffer.events.push(enterTransEv);
reply.raw.write(`data: ${JSON.stringify(enterTransEv)}\n\n`);
```

```typescript
// settle_dungeon（原本的 app.ts:485）
const settleTransEv = { type: "transition", to: "main-space" } as const;
if (currentTurnBuffer) currentTurnBuffer.events.push(settleTransEv);
reply.raw.write(`data: ${JSON.stringify(settleTransEv)}\n\n`);
```

- [ ] **Step 4：執行測試確認通過**

```bash
cd app && npm test -- --reporter=verbose app/src/server/app.test.ts
```

預期：所有測試 PASS（含新增的重連測試）

- [ ] **Step 5：Commit**

```bash
git add app/src/server/app.ts app/src/server/app.test.ts
git commit -m "fix: transition 事件寫入 TurnBuffer，重連後可重播（issue #51 Bug 1）"
```

---

### Task 2：Bug 2 — 轉場後補讀 state，回填 done.state

**Files:**
- Modify: `app/src/server/app.ts:452-487`（轉場區塊）
- Test: `app/src/server/app.test.ts`

**Interfaces:**
- Consumes: `loadState(config.worldDir, turnLogger)` — 已在 `app.ts` import，不需新增
- Produces: 轉場後的 `done.state` 反映落地後的磁碟狀態（`mode` 等欄位正確）

- [ ] **Step 1：寫失敗測試**

在 `app/src/server/app.test.ts` 的 `describe("POST /api/turn（SSE）")` 區塊末尾新增：

```typescript
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
```

- [ ] **Step 2：執行測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose app/src/server/app.test.ts
```

預期：新測試 FAIL（`done.state.mode` 為 `"main-space"` 而非 `"dungeon"`）

- [ ] **Step 3：修改 `app.ts`，轉場後補讀 state**

在轉場區塊（`// 3. 處理轉場` 上方）加入 flag，並在轉場區塊末尾補讀：

```typescript
// 3. 處理轉場
let didTransition = false;

if (done.modeTransition === "enter_dungeon" && !done.transitionDungeonId) {
  // ... 現有 guard 邏輯（Task 3 修改，此處先保持不變）...
}
if (done.modeTransition === "enter_dungeon" && done.transitionDungeonId && state.mode !== "dungeon") {
  // ... 現有 enter_dungeon 邏輯不變 ...
  // 在最後的 done = { ...done, ... } 之前加：
  didTransition = true;
}

if (done.modeTransition === "settle_dungeon") {
  // ... 現有 settle_dungeon 邏輯不變 ...
  // 在最後的 done = { ...done, ... } 之前加：
  didTransition = true;
}

// 轉場後補讀：確保 done.state 反映落地後磁碟狀態（不是轉場前快照）
if (didTransition) {
  try {
    done = { ...done, state: await loadState(config.worldDir, turnLogger) };
  } catch (err) {
    turnLogger.warn({ err }, "轉場後 loadState 失敗，done.state 保留轉場前快照");
  }
}
```

- [ ] **Step 4：執行測試確認通過**

```bash
cd app && npm test -- --reporter=verbose app/src/server/app.test.ts
```

預期：所有測試 PASS

- [ ] **Step 5：Commit**

```bash
git add app/src/server/app.ts app/src/server/app.test.ts
git commit -m "fix: 轉場後補讀 loadState，done.state 反映落地後磁碟狀態（issue #51 Bug 2）"
```

---

### Task 3：Bug 3 — guard 擋下時覆寫 now.nextStep 為過渡狀態

**Files:**
- Modify: `app/src/server/app.ts:1`（import 行，補加 `readFile`/`writeFile`）
- Modify: `app/src/server/app.ts:1`（import 行，補加 `applyNowChanges`/`serializeNow`）
- Modify: `app/src/server/app.ts:9`（import 行，補加 `parseNow`）
- Modify: `app/src/server/app.ts:453-456`（guard 分支本體）
- Test: `app/src/server/app.test.ts`

**Interfaces:**
- Consumes:
  - `readFile(nowPath, "utf8"): Promise<string>` — from `node:fs/promises`
  - `writeFile(nowPath, content, "utf8"): Promise<void>` — from `node:fs/promises`
  - `parseNow(md: string): NowState` — from `../engine/context.js`
  - `applyNowChanges(now: NowState, changes: Partial<NowState>, update: {date,summary}): NowState` — from `../engine/now.js`
  - `serializeNow(now: NowState): string` — from `../engine/now.js`
- Produces: guard 分支結束後 `now.md` 的 `nextStep` 為 `"傳送中（副本目標定位中）"`，下一輪 canonical block 不矛盾

- [ ] **Step 1：寫失敗測試**

在 `app/src/server/app.test.ts` 的 `describe("POST /api/turn（SSE）")` 區塊末尾新增（需要在測試頂部 import 加上 `readFile`，已存在，確認即可）：

```typescript
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
```

- [ ] **Step 2：執行測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose app/src/server/app.test.ts
```

預期：新測試 FAIL（`now.md` 裡仍是「主角即將進入副本，虛空傳送中」，不含「傳送中（副本目標定位中）」）

- [ ] **Step 3：補加 import**

修改 `app/src/server/app.ts` 頂部 import：

```typescript
// 原本：
import { rm } from "node:fs/promises";
// 改為：
import { rm, readFile, writeFile } from "node:fs/promises";
```

```typescript
// 原本：
import { loadState } from "../engine/context.js";
// 改為：
import { loadState, parseNow } from "../engine/context.js";
```

在 `app.ts` 既有 import 區塊（`../engine/now.js` 目前不存在，需新增一行）：

```typescript
import { applyNowChanges, serializeNow } from "../engine/now.js";
```

- [ ] **Step 4：修改 guard 分支本體**

找到 `app.ts:453-456` 的 guard 分支，全部替換為：

```typescript
if (done.modeTransition === "enter_dungeon" && !done.transitionDungeonId) {
  turnLogger.warn("mode_transition=enter_dungeon 但缺 transition_dungeon_id，無法進入副本，停在等玩家");

  try {
    const nowPath = path.join(config.worldDir, "now.md");
    const nowMd = await readFile(nowPath, "utf8");
    const now = applyNowChanges(
      parseNow(nowMd),
      { nextStep: "傳送中（副本目標定位中）" },
      { date: todayISO(), summary: "副本傳送程序已觸發，目標定位中" },
    );
    await writeFile(nowPath, serializeNow(now), "utf8");
  } catch (err) {
    turnLogger.warn({ err }, "guard 補寫 now.md 失敗，略過");
  }

  reply.raw.write(`data: ${JSON.stringify({ type: "warning", message: "系統判定要進入副本，但未能確定副本 id，暫停等玩家確認。" })}\n\n`);
  done = { ...done, modeTransition: null };
}
```

- [ ] **Step 5：執行測試確認通過**

```bash
cd app && npm test -- --reporter=verbose app/src/server/app.test.ts
```

預期：所有測試 PASS

- [ ] **Step 6：執行完整測試套件**

```bash
cd app && npm test
```

預期：全部 PASS，無迴歸

- [ ] **Step 7：Commit**

```bash
git add app/src/server/app.ts app/src/server/app.test.ts
git commit -m "fix: guard 缺 dungeonId 時覆寫 now.nextStep 為傳送中過渡狀態（issue #51 Bug 3）"
```
