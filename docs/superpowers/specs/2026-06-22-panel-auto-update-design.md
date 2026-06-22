# 側邊面板隨回合自動更新 — 設計

日期：2026-06-22

## 問題

前端側邊面板（`StatusPanel` / `NpcPanel`）顯示的狀態完全依賴前端主動呼叫 `fetchState()`（`/api/state`）。目前這只在以下時機觸發：

- 初次載入（`refresh()`）
- 整輪 `/api/turn` SSE 串流**全部跑完之後**的 `await refresh()`
- 分頁從背景切回前景（`visibilitychange`）

後果：後端在每個回合都已把 `now.md`、主角檔同步寫新，但前端在整輪結束前沒有任何「被通知」的管道，所以面板停在舊值不動。使用者觀感是「now.md 被 update 了，但前端不會自動載入最新結果」。在一次送出觸發多個自動推進回合時，中間每個回合的積分／場景／局勢變動完全看不到。

## 目標

每個回合在後端落地（Layer 2：`now.md` + 主角檔寫完並 commit）的同時，前端面板就更新，不必等整輪結束、不引入輪詢。

## 非目標

- 不改變回合引擎的落地時序與三層模型。
- 不為 Layer 3（NPC/wiki 提煉）增加同步等待；維持其 `pendingLoreSync` 非同步接力語意。
- 不改 `/api/state` 的形狀或既有用途。

## 方案：在 SSE `done` 事件內嵌當前 `state`

沿用既有 SSE 推送架構，不新增輪詢。在每個回合的 `done` 事件被 yield 之前，後端讀一次 `loadState()` 並把結果塞進 `done` 事件的新欄位 `state`。前端每收到一個 `done` 就 `setState`，面板隨每回合（含自動推進的中間回合）跳動。

選擇「內嵌進 `done`」而非「另發獨立 `state` 事件」：事件更少、前端一次更新更原子（劇情/建議動作/面板狀態同一筆到位）。

### Layer 3（NPC 等）時序

`done` 事件在 `runTurnCore` 內、`now.md` + 主角檔同步寫完且 commit 之後 yield（`app/src/engine/turn.ts:683`）。此刻 Layer 3（NPC 檔、wiki 提煉）尚未開始或仍在背景跑（`scheduleLoreSync`，不擋回合）。

決策：**不等 Layer 3**，`done` 內嵌的 state 直接反映當下 `loadState()`（now/主角為最新，NPC 可能是上一回合落地的值）。理由與收斂性：

- `runMainSpaceTurn` / `runDungeonTurn` 開頭都 `await deps.pendingLoreSync?.promise`（`turn.ts:862`、`turn.ts:891`），所以**自動推進的下一個回合在 `loadState` 前一定等到上一回合 Layer 3 完成**。第 N 回合的完整 NPC 會隨第 N+1 回合的 `done.state` 一起到位。
- 唯一短暫看到舊 NPC 的情況：整輪最後一個回合（`awaitingUserInput=true` 停下等玩家、後面沒有接力回合）。此時 Layer 3 仍在背景，NPC 慢半拍，直到玩家送下一個動作時新回合 await 修正。體感影響極小，換得實作最單純。

### 轉場（enter/settle dungeon）邊界

`enter_dungeon` / `settle_dungeon` 對 `now.md`「進行中的副本」欄的修改發生在 `runTurnLoop` 裡、回合 `done` **之後**（`turn.ts:1018`、`turn.ts:1034`）。因此 `done.state` 不含該回合的副本欄轉場結果。這由前端串流結束後既有的 `await refresh()` 作為收尾對帳補上——**保留** `send()` 末端的 `refresh()` 當安全網，不移除。

## 變動點

### 1. 契約：`TurnEvent` 的 `done`

`app/src/engine/turn.ts` 與 `app/web/src/api.ts` 兩處的 `done` 型別各加一個欄位：

```
{ type: "done"; narrative; committed; awaitingUserInput; suggestedActions; modeTransition; ...; state: GameState }
```

`GameState` 即 `loadState()` 的回傳型別（engine `context.ts` 的對應型別 / 前端 `api.ts` 的 `GameState`）。

### 2. 後端：`runTurnCore` 組裝 `done`

`app/src/engine/turn.ts:683` yield `done` 前，呼叫 `loadState(deps.worldDir, log)`（now/主角檔此刻已寫完），把結果放進 `done.state`。

- `loadState` 失敗時不可讓回合崩潰：以 try/catch 包裹，失敗則 `state` 省略（`undefined`）並 `log.warn`；前端在缺 `state` 時不更新面板（保留舊值），維持降級安全。

### 3. 前端：`App.tsx` 的 `streamTurn` 回呼

`case "done"` 既有的 `setSuggested(...)` 之外，若 `ev.state` 存在則 `setState(ev.state)`。其餘事件（delta/auto-advance/transition/warning/error）不變。

- 自我癒合輪詢（catch 區塊）與整輪結束 `await refresh()` 維持不動——前者處理斷線、後者對帳轉場後的副本欄與最終 Layer 3。

## 資料流（一次送出，含一個自動推進回合）

1. 玩家送出 → `setBusy(true)`、`setStory("")`。
2. 回合 1：delta 串流 → 落地 now/主角 + commit → `done{state₁}` → 前端 `setState(state₁)`、面板跳到回合 1 結果。
3. `auto-advance` → 回合 2 開始前 `await` 回合 1 的 Layer 3（NPC 落地完）。
4. 回合 2：delta 串流 → 落地 → `done{state₂}`（含回合 1 完整 NPC）→ 前端 `setState(state₂)`。
5. 串流結束 → `await refresh()` 收尾（對帳任何轉場後副本欄變動）。

## 錯誤處理

- 後端 `loadState` 於組 `done` 時失敗：省略 `state`、`log.warn`、回合照常完成。
- 前端 `done` 缺 `state`：不呼叫 `setState`，面板維持上一筆（不清空、不報錯）。
- 既有斷線自我癒合輪詢、`visibilitychange` 同步、整輪結束 `refresh()` 全部保留，互不衝突。

## 測試

- **後端單元（Vitest）**：`runTurnCore` / `runTurnLoop` 的 `done` 事件帶 `state`，且 `state.now`、`state.protagonistDetail` 反映本回合落地後的值（用既有 fake client/commit 注入）。
- **後端單元**：`loadState` 在組 `done` 時拋錯 → `done.state` 為 `undefined`、回合仍正常結束、發出 warning log（不中斷串流）。
- **後端單元**：自動推進多回合時，每個 `done` 各帶一份對應該回合的 `state`。
- **前端單元**：`streamTurn` 收到帶 `state` 的 `done` → `setState` 被呼叫；缺 `state` 的 `done` → 不呼叫 `setState`。
- 覆蓋率維持 80%+。

## 影響檔案

- `app/src/engine/turn.ts`（`done` 型別 + 組裝）
- `app/web/src/api.ts`（`TurnEvent` 的 `done` 型別）
- `app/web/src/App.tsx`（`case "done"` 更新 state）
- 對應測試檔（engine turn 測試、前端測試）
