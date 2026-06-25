# 移除自動推進、簡化回合迴圈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 `runTurnLoop` 及自動推進基礎設施，每回合一律停下等玩家，轉場後送出合成 done 即停，`suggestedActions` 為空時 fallback「順勢而為」。

**Architecture:** `runTurnLoop` 刪除，server `/api/turn` handler 改直接呼叫 `runMainSpaceTurn`/`runDungeonTurn`，轉場邏輯（原本在迴圈內）上移到 server handler 處理，最後送出合成 done 結束 SSE。`auto-advance` 事件型別及相關前端處理一併移除。

**Tech Stack:** Node.js + TypeScript、Fastify SSE、Vitest

## Global Constraints

- 測試框架：Vitest（`cd app && npm test`）
- TypeScript strict mode，無 `any`
- `suggested_actions` 為空時補「順勢而為」，非空時不動
- 轉場後合成 done 不跑新回合的 LLM

---

## 檔案異動總覽

| 檔案 | 動作 |
|------|------|
| `app/src/engine/turn/index.ts` | 刪除 `runTurnLoop`、刪除 `AUTO_CONTINUE_INPUT` import |
| `app/src/engine/turn/shared.ts` | 刪除 `AUTO_CONTINUE_INPUT` 常數 |
| `app/src/engine/turn/types.ts` | 刪除 `auto-advance` 事件型別 |
| `app/src/engine/turn/index.test.ts` | 刪除 `runTurnLoop` 相關 describe blocks |
| `app/src/config.ts` | 刪除 `autoAdvanceMax` 欄位 |
| `app/.env.example` | 刪除 `AUTO_ADVANCE_MAX` 行 |
| `app/src/server/app.ts` | 重寫 `/api/turn` handler：直接呼叫單回合函式、處理轉場、補 fallback 按鈕 |
| `app/src/server/app.test.ts` | 新增三個 integration test |
| `app/web/src/api.ts` | 刪除 `auto-advance` 事件型別 |
| `app/web/src/App.tsx` | 刪除 `auto-advance` case |
| `app/src/engine/turn/prompts.ts` | 更新 `awaiting_user_input` 與 `suggested_actions` 說明 |

---

### Task 1：刪除 `auto-advance` 事件型別與前端處理

**Files:**
- Modify: `app/src/engine/turn/types.ts`
- Modify: `app/web/src/api.ts`
- Modify: `app/web/src/App.tsx`

**Interfaces:**
- Consumes: 無
- Produces: `TurnEvent`（後端）不再含 `auto-advance`；`TurnEvent`（前端 api.ts）同步

- [ ] **Step 1: 從後端 TurnEvent 刪除 auto-advance**

在 `app/src/engine/turn/types.ts` 中，找到這行並刪除：

```typescript
| { type: "auto-advance"; index: number }
```

- [ ] **Step 2: 從前端 TurnEvent 刪除 auto-advance**

在 `app/web/src/api.ts` 中，找到這行並刪除：

```typescript
| { type: "auto-advance"; index: number }
```

- [ ] **Step 3: 刪除前端 auto-advance case**

在 `app/web/src/App.tsx` 中，刪除以下 case（約 L88-90）：

```typescript
          case "auto-advance":
            setStory((s) => s + "\n\n—— 系統自動推進 ——\n\n");
            break;
```

- [ ] **Step 4: 跑 TypeScript 型別檢查確認無錯**

```bash
cd app && npx tsc --noEmit
```

預期：無錯誤

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/types.ts app/web/src/api.ts app/web/src/App.tsx
git commit -m "refactor: 刪除 auto-advance 事件型別與前端處理"
```

---

### Task 2：刪除 `AUTO_CONTINUE_INPUT`、`runTurnLoop` 與 config 中的 `autoAdvanceMax`

**Files:**
- Modify: `app/src/engine/turn/shared.ts`
- Modify: `app/src/engine/turn/index.ts`
- Modify: `app/src/config.ts`
- Modify: `app/.env.example`

**Interfaces:**
- Consumes: 無
- Produces: `runMainSpaceTurn`、`runDungeonTurn` 仍 export（server Task 3 使用）；`runTurnLoop` 不再 export

- [ ] **Step 1: 刪除 `AUTO_CONTINUE_INPUT`**

在 `app/src/engine/turn/shared.ts` 中，找到並刪除：

```typescript
export const AUTO_CONTINUE_INPUT = "（系統自動推進：延續上一刻，繼續敘事，玩家未介入）";
```

- [ ] **Step 2: 刪除 `runTurnLoop` 函式及其 import**

在 `app/src/engine/turn/index.ts` 中：

1. 刪除頂部的 import（若存在）：
```typescript
import { AUTO_CONTINUE_INPUT, readBestEffort, todayISO } from "./shared.js";
```
改成（移除 `AUTO_CONTINUE_INPUT`）：
```typescript
import { readBestEffort, todayISO } from "./shared.js";
```

2. 刪除整個 `runTurnLoop` 函式（從第 170 行 `/** Mode-aware 自動推進迴圈...` 到最後的 `}`，約 90 行）。

3. 刪除 export 行：
```typescript
export type { PendingLoreSync, TurnDeps, TurnEvent } from "./types.js";
```
中不需要同步刪除（`PendingLoreSync` 等仍有效），但需確認 `runTurnLoop` 從 export 移除——因為它是具名函式 export，只要刪除函式本身即可。

- [ ] **Step 3: 刪除 config 中的 `autoAdvanceMax`**

在 `app/src/config.ts` 中，刪除：
- interface 欄位：`autoAdvanceMax: number;`（約 L20）
- DEFAULTS 預設值：`autoAdvanceMax: 4,`（約 L67）
- parseConfig 行：`autoAdvanceMax: parsePositiveInt(env.AUTO_ADVANCE_MAX, DEFAULTS.autoAdvanceMax),`（約 L125）

- [ ] **Step 4: 刪除 .env.example 中的 AUTO_ADVANCE_MAX**

在 `app/.env.example` 中刪除：

```
AUTO_ADVANCE_MAX=4
```

- [ ] **Step 5: 跑型別檢查**

```bash
cd app && npx tsc --noEmit
```

預期：無錯誤（若有 `config.autoAdvanceMax` 殘留在 server/app.ts，這步會報錯，先記下，Task 3 會修）

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/turn/shared.ts app/src/engine/turn/index.ts app/src/config.ts app/.env.example
git commit -m "refactor: 刪除 runTurnLoop、AUTO_CONTINUE_INPUT、autoAdvanceMax 設定"
```

---

### Task 3：重寫 server `/api/turn` handler

**Files:**
- Modify: `app/src/server/app.ts`

**Interfaces:**
- Consumes: `runMainSpaceTurn(deps, input): AsyncGenerator<TurnEvent>`、`runDungeonTurn(deps, input): AsyncGenerator<TurnEvent>`（來自 `app/src/engine/turn/index.ts`）
- Consumes: `enterDungeon`、`setNowActiveDungeon`、`renameLogAfterSettle`、`parseActiveDungeon`、`formatActiveDungeon`（已在 server/app.ts 使用或可從 engine 引入）
- Produces: `/api/turn` SSE stream，事件序列為 `ping → delta... → [transition →] done`

**新的 handler 邏輯：**

```typescript
// 1. 讀狀態決定跑哪種回合
const state = await loadState(config.worldDir, turnLogger);
const gen = state.mode === "dungeon"
  ? runDungeonTurn(deps, input)
  : runMainSpaceTurn(deps, input);

// 2. 逐事件轉發，截留 done
let done: Extract<TurnEvent, { type: "done" }> | null = null;
for await (const ev of gen) {
  if (ev.type === "done") { done = ev; continue; }
  reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
}
if (!done) return; // 異常降級，已有 warning 事件

// 3. 處理轉場
if (done.modeTransition === "enter_dungeon" && done.transitionDungeonId) {
  await pendingLoreSync.promise;
  const settingText = await readBestEffort(path.join(config.worldDir, "setting.md"));
  const secretsText = await generateSecrets(makeClient(turnLogger), settingText, done.transitionDungeonId);
  const active = await enterDungeon(config.worldDir, {
    dungeonId: done.transitionDungeonId,
    today: todayISO(),
    protagonistSummary: `${state.protagonist.name}（積分 ${state.protagonist.points}）`,
    goal: done.transitionDungeonGoal?.trim() || "（待劇情揭露）",
    secretsText,
  }, turnLogger);
  await setNowActiveDungeon(config.worldDir, formatActiveDungeon(active), {
    date: todayISO(),
    summary: `進入副本 ${active.dungeonId}`,
  });
  await makeCommit(turnLogger)(`進入副本 ${active.dungeonId} ${active.runId}`);
  reply.raw.write(`data: ${JSON.stringify({ type: "transition", to: "dungeon", dungeonId: active.dungeonId })}\n\n`);
  // 合成 done
  done = { ...done, modeTransition: null, suggestedActions: ["順勢而為"], awaitingUserInput: true };
}

if (done.modeTransition === "settle_dungeon") {
  await pendingLoreSync.promise;
  const activeForSettle = parseActiveDungeon(state.now.activeDungeon);
  if (activeForSettle) await renameLogAfterSettle(config.worldDir, activeForSettle.dungeonId, turnLogger);
  await setNowActiveDungeon(config.worldDir, "無", { date: todayISO(), summary: "副本結算，返回安全區" });
  await makeCommit(turnLogger)("副本結算，返回安全區");
  reply.raw.write(`data: ${JSON.stringify({ type: "transition", to: "main-space" })}\n\n`);
  done = { ...done, modeTransition: null, suggestedActions: ["順勢而為"], awaitingUserInput: true };
}

// 4. fallback 按鈕
if (done.suggestedActions.length === 0) {
  done = { ...done, suggestedActions: ["順勢而為"] };
}

// 5. 送出最終 done
reply.raw.write(`data: ${JSON.stringify(done)}\n\n`);
```

- [ ] **Step 1: 更新 import**

在 `app/src/server/app.ts` 頂部，找到 engine turn 相關 import，改成引入單回合函式：

```typescript
import { runMainSpaceTurn, runDungeonTurn, type PendingLoreSync } from "../engine/turn/index.js";
```

並確認以下已有 import（若無則新增）：
```typescript
import { enterDungeon, formatActiveDungeon, parseActiveDungeon, renameLogAfterSettle } from "../engine/dungeon.js";
import { setNowActiveDungeon } from "../engine/turn/dungeon-transition.js";
import { generateSecrets } from "../engine/turn/dungeon-transition.js";
import { loadState } from "../engine/context.js";
import { readBestEffort, todayISO } from "../engine/turn/shared.js";
```

- [ ] **Step 2: 重寫 `/api/turn` handler**

找到現有 handler（約 L285），將 `for await (const ev of runTurnLoop(...))` 那整段 try block 替換成上方「新的 handler 邏輯」中的程式碼。

注意：
- `deps` 物件（`client`、`worldDir`、`commit` 等）與原本相同，只是移除 `autoAdvanceMax` 傳入
- `config.autoAdvanceMax` 引用需同步刪除
- comment 改為「推進主空間/副本敘事回合，以 SSE 串流 delta/done 事件」

- [ ] **Step 3: 跑型別檢查**

```bash
cd app && npx tsc --noEmit
```

預期：無錯誤

- [ ] **Step 4: Commit**

```bash
git add app/src/server/app.ts
git commit -m "refactor(server): 移除 runTurnLoop，改直接呼叫單回合函式，轉場後合成 done"
```

---

### Task 4：更新 prompts.ts 說明文字

**Files:**
- Modify: `app/src/engine/turn/prompts.ts`

**Interfaces:**
- Consumes: 無
- Produces: 無（純 prompt string 修改）

- [ ] **Step 1: 更新 `awaiting_user_input` 說明**

在 `app/src/engine/turn/prompts.ts` 約 L39，找到：

```typescript
"- awaiting_user_input: boolean —— 敘事屬純環境/系統旁白/NPC 自行動作、玩家不需做決定時設 false；需要玩家選擇才設 true。",
```

改成：

```typescript
"- awaiting_user_input: boolean —— 此回合有明確玩家決策點時設 true，純環境/系統旁白/NPC 自行動作時設 false（引擎不因此改變行為，僅供語意標記）。",
```

- [ ] **Step 2: 更新 `suggested_actions` 說明**

在 `prompts.ts` 找到 `suggested_actions` 的說明行，在其後補一行：

```typescript
"  （若此回合無明確決策點，可給空陣列，引擎會自動補上預設選項。）",
```

- [ ] **Step 3: 跑測試確認 prompt 相關測試未受影響**

```bash
cd app && npm test -- src/engine/turn/index.test.ts
```

預期：39 tests passed（若已有其他測試刪除，數量會少）

- [ ] **Step 4: Commit**

```bash
git add app/src/engine/turn/prompts.ts
git commit -m "docs(prompts): 更新 awaiting_user_input 與 suggested_actions 說明"
```

---

### Task 5：刪除 `runTurnLoop` 相關測試，新增 server integration tests

**Files:**
- Modify: `app/src/engine/turn/index.test.ts`
- Modify: `app/src/server/app.test.ts`

**Interfaces:**
- Consumes: 無
- Produces: server integration tests 覆蓋轉場後即停與 fallback 按鈕行為

- [ ] **Step 1: 刪除 `runTurnLoop` 相關 describe blocks**

在 `app/src/engine/turn/index.test.ts` 中刪除以下三個 describe blocks（連同其內所有 it）：

1. `describe("runTurnLoop — 自動推進", ...)` 約 L629–L678
2. `describe("runTurnLoop — 進入/結算副本（不切 branch）", ...)` 約 L946–L1113
3. `describe("done.state 降級與自動推進多回合覆蓋", ...)` 約 L1248–L1330（其中 `"done 前 loadState 失敗"` 那個 it 不依賴 runTurnLoop，可保留，移到其他 describe 下）

同時刪除 import 中的 `runTurnLoop`：
```typescript
import { runMainSpaceTurn, runDungeonTurn, runTurnLoop, type TurnEvent, type TurnDeps, type PendingLoreSync } from "./index.js";
```
改成：
```typescript
import { runMainSpaceTurn, runDungeonTurn, type TurnEvent, type TurnDeps, type PendingLoreSync } from "./index.js";
```

- [ ] **Step 2: 跑 index.test.ts 確認通過**

```bash
cd app && npm test -- src/engine/turn/index.test.ts
```

預期：全部 pass，無 `runTurnLoop` 相關錯誤

- [ ] **Step 3: 寫三個 server integration test**

在 `app/src/server/app.test.ts` 中，找到現有的 SSE 解析輔助函式（若無則在頂部新增）：

```typescript
function parseSSEEvents(body: string): any[] {
  return body
    .split("\n\n")
    .map((chunk) => chunk.replace(/^data: /, "").trim())
    .filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
```

在 `describe("POST /api/turn"` 區塊末尾，新增三個 it：

```typescript
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
```

- [ ] **Step 4: 跑新增的測試確認通過**

```bash
cd app && npm test -- src/server/app.test.ts
```

預期：新增的三個 test pass

- [ ] **Step 5: 跑完整測試套件**

```bash
cd app && npm test
```

預期：全套 pass（`app.test.ts` 中既有失敗的三個 `/api/world/init` 是先前已知問題，不計入）

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/turn/index.test.ts app/src/server/app.test.ts
git commit -m "test: 刪除 runTurnLoop 測試，補 server integration test（fallback 按鈕、轉場後即停）"
```

---

## 執行後驗收

1. `npm test` 全套通過（排除已知的三個 `/api/world/init` 失敗）
2. `npx tsc --noEmit` 無錯誤
3. `grep -r "runTurnLoop\|AUTO_CONTINUE_INPUT\|autoAdvanceMax\|auto-advance" app/src app/web/src` 無命中
4. 手動測試：送出一個回合，確認 SSE 只收到一次 `done`，`suggestedActions` 非空時顯示正確按鈕，空時顯示「順勢而為」
