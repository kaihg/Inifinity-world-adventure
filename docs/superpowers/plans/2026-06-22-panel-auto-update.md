# 側邊面板隨回合自動更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓前端側邊面板在每個回合（含自動推進的中間回合）落地時就更新，而非等整輪 SSE 結束。

**Architecture:** 後端在每個回合 yield `done` 事件前，讀一次 `loadState()` 並內嵌進 `done.state`；前端收到 `done` 就 `setState(ev.state)`。沿用既有 SSE 推送架構，不引入輪詢。Layer 3（NPC/wiki）不等，靠下一回合開頭既有的 `await pendingLoreSync` 自然收斂；轉場後的副本欄由前端串流結束後既有的 `refresh()` 收尾。

**Tech Stack:** Node.js + TypeScript、Vitest（後端）、Fastify SSE、React + Vite（前端）。

> **重要背景（2026-06-22 更新）：** main 已將舊 `app/src/engine/turn.ts` 拆分為 `app/src/engine/turn/` 模組（PR #38）。本 plan 的路徑與行號均針對拆分後結構：
> - `TurnEvent` 型別 → `app/src/engine/turn/types.ts`
> - 組裝 `done` 的 `runTurnCore` → `app/src/engine/turn/turn-core.ts`
> - 回合入口 `runMainSpaceTurn` / `runDungeonTurn` / `runTurnLoop` → `app/src/engine/turn/index.ts`
> - 回合測試 → `app/src/engine/turn/index.test.ts`
> 前端 `App.tsx` / `api.ts` 不在這波重構範圍，與舊 plan 一致。

## Global Constraints

- 狀態文件契約不變：三層落地模型、`now.md` 欄位、`pendingLoreSync` 非同步接力語意全部維持。
- 不改 `/api/state` 的形狀與用途。
- `loadState(worldDir, logger?)` 回傳 `GameState`（`app/src/engine/context.ts:285`），欄位：`now / protagonist / protagonistDetail / npcs / mode / lastTurn`。
- **`runTurnCore` 自己不呼叫 `loadState`**：它在 `app/src/engine/turn/index.ts` 的 `runMainSpaceTurn` / `runDungeonTurn` 拿到回合開頭載入的 `state` 後當參數傳入（`turn-core.ts:22`）。本 plan 要在 `runTurnCore` 內、yield `done` 前**重新讀一次** `loadState`，因為主腦/Layer 2 落地已改寫 `now.md`、主角檔，回合開頭那份 `state` 已過時。
- 後端測試慣例：用 `fakeClient([...])` / `sequencedClient([...])` 與注入式 `commit`，驗 `done` 事件欄位並讀 `world/` 檔案內容（見 `app/src/engine/turn/index.test.ts`）。
- 繁體中文、台灣用詞；commit message 用 conventional commits。
- 全程在 `app/` 目錄下執行測試指令（`cd app`）。

## File Structure

- `app/src/engine/turn/types.ts` — `TurnEvent` 的 `done` 變體新增 `state?: GameState`。
- `app/src/engine/turn/turn-core.ts` — import `loadState`；`runTurnCore` 在 yield `done` 前讀 `loadState` 組裝 `state`（含失敗降級）。
- `app/web/src/api.ts` — 前端 `TurnEvent` 的 `done` 變體鏡像新增 `state?: GameState`。
- `app/web/src/App.tsx` — `case "done"` 在既有 `setSuggested` 之外，`ev.state` 存在時 `setState(ev.state)`。
- `app/src/engine/turn/index.test.ts` — 新增測試：`done.state` 帶本回合落地後狀態；`loadState` 失敗時 `done.state` 為 `undefined` 且回合正常結束；自動推進多回合各帶對應 `state`。

### 前端測試策略（明確取捨）

本 repo 前端**無測試框架**（`vitest.config.ts` 只含 `src/**/*.test.ts`、node 環境，`web/` 無 jsdom / React Testing Library）。前端改動為單行 guarded setter（`if (ev.state) setState(ev.state)`）。為此引入 jsdom + RTL 不成比例（違反 YAGNI）。

決定：**後端走完整 TDD**（資料正確性全在後端，已有成熟測試慣例可覆蓋契約）；**前端走最小改動 + 手動驗證**（Task 4 提供具體 dev 觀察步驟）。此為刻意的範圍決定，非遺漏。

---

### Task 1: 後端 `done` 事件型別新增 `state` 欄位

**Files:**
- Modify: `app/src/engine/turn/types.ts`（`TurnEvent` 的 `done` 變體，`:46-55`）

**Interfaces:**
- Consumes: `GameState`（型別）。`types.ts` 是否已 import `GameState` 需確認；未 import 則加上。
- Produces: `TurnEvent` 的 `done` 變體新增選填欄位 `state?: GameState`。

- [ ] **Step 1: 確認並補上 `GameState` import**

檢視 `app/src/engine/turn/types.ts` 頂部 import。確認是否已從 `../context.js` 帶入 `GameState`；若無，補上（與既有 import 風格一致，type-only import）：

```typescript
import type { GameState } from "../context.js";
```

> 註：若 `types.ts` 已有從 `../context.js` 匯入的行，將 `GameState` 併入該行即可，不要新增重複的 import 來源。

- [ ] **Step 2: 在 `done` 變體加上 `state?` 欄位**

把 `TurnEvent` 的 `done` 物件（`types.ts:46-55`）改為：

```typescript
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: FastControl["mode_transition"];
      transitionDungeonId?: string;
      transitionDungeonGoal?: string;
      /** 本回合 Layer 2 落地後的當前狀態快照，供前端面板即時更新；loadState 失敗時省略 */
      state?: GameState;
    };
```

- [ ] **Step 3: 編譯檢查**

Run: `cd app && npx tsc --noEmit`
Expected: 無錯誤（`state` 為選填，尚未有人賦值，既有 yield 不受影響）。

- [ ] **Step 4: Commit**

```bash
git add app/src/engine/turn/types.ts
git commit -m "feat(engine): done 事件型別新增選填 state 欄位"
```

---

### Task 2: `runTurnCore` 在 `done` 內嵌當前 state（含失敗降級）

**Files:**
- Modify: `app/src/engine/turn/turn-core.ts`（import 區 `:1-12`；yield `done` 處 `:119-128`）
- Test: `app/src/engine/turn/index.test.ts`

**Interfaces:**
- Consumes: `loadState(deps.worldDir, log)`、`done` 變體的 `state?: GameState`（Task 1）、`runTurnCore` 既有參數 `log: Logger`（`turn-core.ts:26`）。
- Produces: 每個 `done` 事件帶 `state`（成功時）或省略（`loadState` 拋錯時）。

- [ ] **Step 1: 寫失敗測試 — done 帶本回合落地後 state**

在 `app/src/engine/turn/index.test.ts` 既有「串流敘事、副大腦套用 now/積分」測試（`:110`）所在的 describe 區塊內新增測試。沿用該檔頂部既有的 `fakeClient`、`world` fixture、`readFile`、`path` 匯入：

```typescript
  it("done 帶本回合 Layer 2 落地後的 state 快照", async () => {
    const narrative = "沈奕走進資訊室。";
    const ctrl = JSON.stringify({
      state_changes: { now: { scene: "資訊室", nextStep: "找葉晴" }, protagonist_points_delta: 2 },
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: ["找葉晴"],
      commit_summary: "沈奕進資訊室",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient([narrative]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [10, 20],
      },
      "去資訊室",
    )) {
      events.push(ev);
    }

    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.state).toBeDefined();
    expect(done.state.now.scene).toBe("資訊室");
    expect(done.state.now.nextStep).toBe("找葉晴");
    expect(Number(done.state.protagonist.points)).toBeGreaterThanOrEqual(2);
  });
```

> 註：`protagonist.points` 為字串型（`ProtagonistSummary`）。用 `Number(...)>=2` 避免綁死 fixture 初始積分。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts -t "done 帶本回合"`
Expected: FAIL（`done.state` 為 `undefined`）。

- [ ] **Step 3: import `loadState`**

`turn-core.ts` 目前只從 `../context.js` 帶入 `applyPointsDelta` / `applyProtagonistUpdates` / `type GameState`（`:4-8`），**沒有** `loadState`。把該 import 區補上 `loadState`：

```typescript
import {
  applyPointsDelta,
  applyProtagonistUpdates,
  loadState,
  type GameState,
} from "../context.js";
```

- [ ] **Step 4: 實作 — yield done 前讀 state**

在 `runTurnCore` 的 `yield { type: "done", ... }`（`turn-core.ts:119`）**之前**插入讀取（接在 `:117` 的 `log.info(...)` 之後、`yield` 之前）。此刻 `now.md`、主角檔已同步寫完且 commit（`:108`）：

```typescript
  // done 前讀一次當前狀態快照，內嵌進事件供前端面板即時更新。
  // 此刻 now.md / 主角檔已落地；Layer 3（NPC/wiki）尚未開始，故 NPC 可能仍是上一回合值（見 spec）。
  // loadState 失敗不可讓回合崩潰：省略 state、warn、回合照常結束。
  let stateSnapshot: GameState | undefined;
  try {
    stateSnapshot = await loadState(deps.worldDir, log);
  } catch (err) {
    log.warn({ err }, "done 前 loadState 失敗，本回合 done 不帶 state 快照");
  }

  yield {
    type: "done",
    narrative,
    committed,
    awaitingUserInput: control?.awaiting_user_input ?? true,
    suggestedActions,
    modeTransition: control?.mode_transition ?? null,
    transitionDungeonId: control?.transition_dungeon_id || undefined,
    transitionDungeonGoal: control?.transition_dungeon_goal || undefined,
    state: stateSnapshot,
  };
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts -t "done 帶本回合"`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/turn/turn-core.ts app/src/engine/turn/index.test.ts
git commit -m "feat(engine): runTurnCore 在 done 內嵌當前 state 快照"
```

---

### Task 3: `loadState` 失敗降級 + 自動推進多回合各帶 state 的測試

**Files:**
- Test: `app/src/engine/turn/index.test.ts`

**Interfaces:**
- Consumes: Task 2 的降級實作（`loadState` 拋錯 → `done.state === undefined`、回合正常結束）。

- [ ] **Step 1: 寫降級測試 — loadState 失敗時 done 不帶 state 且回合不崩潰**

`runTurnCore` 在 `done` 前呼叫 `loadState(deps.worldDir, log)`，來源是 `../context.js`。用 `vi.spyOn` 對該模組注入：回合開頭那次（`index.ts` 的 `runMainSpaceTurn`）正常、`done` 前那次拋錯。在 `index.test.ts` 既有 import 之外新增：

```typescript
import { vi } from "vitest";
import * as contextMod from "../context.js";
```

測試本體（放在與 Task 2 同一 describe）：

```typescript
  it("done 前 loadState 失敗時，done 不帶 state 且回合仍正常結束", async () => {
    const ctrl = JSON.stringify({
      state_changes: {},
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: [],
      commit_summary: "回合",
    });

    const real = contextMod.loadState;
    let calls = 0;
    const spy = vi.spyOn(contextMod, "loadState").mockImplementation(async (dir, logger) => {
      calls += 1;
      if (calls >= 2) throw new Error("模擬 loadState 失敗");
      return real(dir, logger);
    });

    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["一段敘事。"]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [10, 20],
      },
      "看看四周",
    )) {
      events.push(ev);
    }

    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.state).toBeUndefined();
    spy.mockRestore();
  });
```

> 註：`runMainSpaceTurn` 開頭呼叫一次 `loadState`（見 `index.ts`），`runTurnCore` 的 done 前再呼叫一次。`calls >= 2` 命中 done 前那次。若實際呼叫鏈使首次載入不只一次 `loadState`（例如副本路徑），調整門檻使首次回合載入成功、done 前那次失敗，並以 `mockRestore` 收尾。
> 另注意：`vi.spyOn` 對 ESM 具名匯出的可變性依 vitest 設定而定。若 spy 無法攔截（拋出「不可重新賦值」），改用 vitest 的 `vi.mock("../context.js", ...)` 工廠並保留其餘具名匯出（`importActual`）：mock `loadState` 為計數版本、其餘原樣 re-export。以實際能攔截的方式為準。

- [ ] **Step 2: 跑測試確認通過（實作已在 Task 2 完成）**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts -t "loadState 失敗"`
Expected: PASS。

- [ ] **Step 3: 寫自動推進測試 — 每個 done 各帶對應 state**

參考既有「runTurnLoop — 自動推進」測試的注入方式（在 `index.test.ts` 內，搜尋 `runTurnLoop`）。多回合時主腦與 control client 每回合各被呼叫一次，故 `fakeClient` 各給多筆依序對應：

```typescript
  it("自動推進多回合時，每個 done 各帶一份 state 快照", async () => {
    const ctrlAuto = JSON.stringify({
      state_changes: { now: { scene: "走廊" } },
      rolls: [],
      mode_transition: null,
      awaiting_user_input: false,
      suggested_actions: [],
      commit_summary: "自動推進回合",
    });
    const ctrlStop = JSON.stringify({
      state_changes: { now: { scene: "房間" } },
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: ["休息"],
      commit_summary: "停下",
    });

    const events: TurnEvent[] = [];
    for await (const ev of runTurnLoop(
      {
        client: fakeClient(["第一段。", "第二段。"]),
        controlClient: fakeClient([ctrlAuto, ctrlStop]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [10, 20, 30, 40],
      },
      "前進",
      3,
    )) {
      events.push(ev);
    }

    const dones = events.filter((e) => e.type === "done") as any[];
    expect(dones).toHaveLength(2);
    expect(dones[0].state).toBeDefined();
    expect(dones[1].state).toBeDefined();
    expect(dones[1].state.now.scene).toBe("房間");
  });
```

> 註：`fakeClient` 的 chunks 依序對應每次 `streamChat`。若該 fixture 的回合還會觸發 character pre-pass / lore-sync 的額外 client 呼叫，依既有自動推進測試（搜尋 `runTurnLoop`）的注入模式補齊對應 fake；以實際既有測試怎麼注入為準。`runTurnLoop` 第三參數為 `maxAuto`，此處給 3。

- [ ] **Step 4: 跑全部 turn 模組測試**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts`
Expected: PASS（含既有測試不回歸）。

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/index.test.ts
git commit -m "test(engine): done.state 降級與自動推進多回合覆蓋"
```

---

### Task 4: 前端 `done` 事件更新面板

**Files:**
- Modify: `app/web/src/api.ts`（`TurnEvent` 的 `done` 變體，`:65-72`）
- Modify: `app/web/src/App.tsx`（`streamTurn` 回呼 `case "done"`，`:92-94`）

**Interfaces:**
- Consumes: 後端 `done` 事件新增的 `state?: GameState`（Task 2）；前端既有 `GameState` 型別（`api.ts:32`）與 `setState`（`App.tsx:7`）。
- Produces: `done` 帶 `state` 時面板即時更新。

- [ ] **Step 1: 前端 `TurnEvent` 鏡像新增 `state`**

`app/web/src/api.ts` 的 `done` 變體（`:65-72`）改為：

```typescript
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: string | null;
      state?: GameState;
    };
```

（`GameState` 已在同檔 `:32` 定義，無需額外 import。）

- [ ] **Step 2: `case "done"` 更新面板**

`app/web/src/App.tsx` 的 `case "done"`（`:92-94`）改為：

```typescript
          case "done":
            setSuggested(ev.suggestedActions ?? []);
            if (ev.state) setState(ev.state);
            break;
```

其餘 case（delta/auto-advance/transition/warning/error）與 catch 自我癒合輪詢、串流結束 `await refresh()` 全部保持不動。

- [ ] **Step 3: 編譯與 build 檢查**

Run: `cd app && npx tsc --noEmit` 以及 `cd app && npm run build`
Expected: 後端與前端 build 皆無型別錯誤。

- [ ] **Step 4: 手動驗證面板隨回合更新**

前端無自動化測試框架（見「前端測試策略」），以 dev 手動驗證：

```bash
cd app && npm run dev
```

開 http://localhost:5174，送一個會觸發自動推進的行動（例如純環境探索類，使 `awaiting_user_input=false`）。觀察：
- 劇情串流中／剛結束時，右側面板「此刻場景／地點」「積分」隨**每個回合**更新，而非等整輪結束才一次跳。
- 自動推進的中間回合也看得到局勢變動。
- 確認 NPC 面板在「停下等玩家」後可能慢半拍，送下一個動作後恢復一致（符合 spec 的 Layer 3 收斂預期）。

- [ ] **Step 5: Commit**

```bash
git add app/web/src/api.ts app/web/src/App.tsx
git commit -m "feat(web): done 事件帶 state 時即時更新側邊面板"
```

---

### Task 5: 全套回歸與收尾

**Files:** 無（驗證）

- [ ] **Step 1: 跑後端全測**

Run: `cd app && npm test`
Expected: 全 PASS，覆蓋率不低於既有水準（80%+）。

- [ ] **Step 2: 確認既有安全網未被破壞**

人工檢視 `App.tsx`：catch 區塊的自我癒合輪詢、`visibilitychange` 同步、串流結束 `await refresh()` 三者皆保留（spec 要求保留作為轉場副本欄與最終 Layer 3 的收尾對帳）。

- [ ] **Step 3: 最終 commit（如有殘留變更）**

```bash
git add -A && git commit -m "chore: 面板隨回合自動更新收尾" || echo "無殘留變更"
```

---

## Self-Review

**1. Spec coverage：**
- 「每回合 done 內嵌 state」→ Task 2 ✓
- 「Layer 3 不等、自動推進靠 await pendingLoreSync 收斂」→ 既有行為，無需程式改動；測試於 Task 3 自動推進案間接覆蓋，邏輯於 Task 2 註解記錄 ✓
- 「轉場由前端 refresh 收尾、保留 refresh」→ Task 4 Step 2 明文保留、Task 5 Step 2 驗證 ✓
- 「loadState 失敗降級」→ Task 2 實作 + Task 3 測試 ✓
- 「前端缺 state 不更新」→ Task 4 Step 2 `if (ev.state)` guard ✓
- 「契約：兩處 TurnEvent done 加 state」→ Task 1（後端型別 types.ts）+ Task 4 Step 1（前端型別）✓
- 「前端單元測試」→ 因 repo 無前端測試框架，改為手動驗證並明文標註取捨（Task 4 Step 4 + File Structure 區段）。刻意決定，非遺漏。

**2. Placeholder scan：** 無 TBD/TODO；每個 code step 均含實際程式碼與指令。`loadState` 失敗測試（spy vs mock）與自動推進測試的 fakeClient 呼叫次數附「以既有測試為準」的調整指引，因實際 client 呼叫鏈依 fixture 而定。

**3. Type / 路徑 consistency：** `state?: GameState` 在後端（Task 1, `types.ts`）與前端（Task 4, `api.ts`）兩處型別一致；`runTurnCore` 自己不收 `loadState`、需 Task 2 Step 3 新增 import（已對齊 `turn-core.ts:4-8` 現況，只有 `type GameState`）；`loadState(worldDir, log)` 簽名與 `context.ts:285` 一致；`protagonist.points` 為字串（Task 2 Step 1 用 `Number(...)` 處理）；所有路徑指向拆分後的 `engine/turn/` 模組。
