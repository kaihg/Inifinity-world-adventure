# 移除自動推進、簡化回合迴圈設計

**日期**：2026-06-25
**狀態**：已核准，待實作

## 背景

`runTurnLoop` 迴圈最初為了支援「純環境/NPC 敘事回合不需玩家介入」而設計，當 Layer 2 回傳 `awaiting_user_input=false` 時自動接續下一回合。但實際運作上：

1. 迴圈讓架構複雜度顯著提升（buffer 策略、多回合 done 管理）。
2. Issues #49/#50 的根因都源自這個迴圈的時序問題。
3. 自架 72B 模型每回合推論需要 60–150 秒，自動推進只是讓玩家「等一段時間後再等一段時間」，體驗優勢幾乎不存在。

決策：移除自動推進迴圈，每回合一律停下等玩家，同時提供「順勢而為」作為預設 fallback 按鈕，讓玩家輕鬆繼續而不需要自行輸入文字。

## 設計目標

- 移除 `runTurnLoop` 及一切自動推進基礎設施
- 每次 `/api/turn` 請求只跑一個回合，最多附帶一次轉場（enter/settle dungeon）
- `suggestedActions` 為空時，引擎自動補「順勢而為」
- 前端不需要特殊邏輯，「順勢而為」就是一個普通的 chip 按鈕

## 刪除項目

| 項目 | 位置 |
|------|------|
| `runTurnLoop` 函式 | `app/src/engine/turn/index.ts` |
| `AUTO_CONTINUE_INPUT` 常數 | `app/src/engine/turn/shared.ts` |
| `autoAdvanceMax` 設定欄位 | `app/src/config.ts` |
| `AUTO_ADVANCE_MAX` 環境變數 | `app/.env.example` |
| `auto-advance` 事件型別 | `app/src/engine/turn/types.ts`、`app/web/src/api.ts` |
| `auto-advance` 事件的前端處理 | `app/web/src/App.tsx` |

## 後端：`/api/turn` handler 調整

原本：
```
for await (const ev of runTurnLoop(deps, input, config.autoAdvanceMax)) { ... }
```

改成：
1. 讀 `loadState` 判斷 `state.mode`
2. 直接呼叫 `runMainSpaceTurn(deps, input)` 或 `runDungeonTurn(deps, input)`
3. 收集到 `done` 後，若有 `mode_transition`，在同一個 SSE 請求內執行轉場（`enterDungeon` 或副本結算），yield `transition` 事件，然後結束 SSE（不繼續跑下一回合）
4. 在 SSE 結束前，若 `done.suggestedActions` 為空，補 `["順勢而為"]` 再送出

轉場後的流程（入副本）：
```
主空間回合完成 → done(enter_dungeon) →
  執行 enterDungeon → setNowActiveDungeon → commit →
  yield transition(dungeon) →
  yield 合成 done { awaitingUserInput:true, suggestedActions:["順勢而為"], ... } →
  結束
```

結算副本：
```
副本回合完成 → done(settle_dungeon) →
  renameLog → setNowActiveDungeon("無") → commit →
  yield transition(main-space) →
  yield 合成 done { awaitingUserInput:true, suggestedActions:["順勢而為"], ... } →
  結束
```

轉場後的 `done` 是 server 直接組出的最小事件（不再跑一個新回合），只需要足夠讓前端解鎖按鈕。`narrative`、`committed`、`protagonistDied` 等欄位使用安全預設值。

## Schema / Prompt 調整

**`awaiting_user_input`**：欄位保留在 schema（不造成 breaking change），但 prompt 移除「引擎會自動推進」的說明，改為純語意標記：「false 表示此回合無需玩家決策（純環境/NPC 動作），引擎不會因此改變行為，但可作為前端顯示參考。」

**`suggested_actions`**：prompt 補充說明：「若此回合無明確決策點，可給空陣列，引擎會自動補上預設選項『順勢而為』。」

## 前端調整

- 移除 `auto-advance` case（`App.tsx`）
- 無其他修改；「順勢而為」由後端補進 `suggestedActions`，前端視作普通 chip

## 測試調整

**刪除**：
- `runTurnLoop` 相關的全部測試（`index.test.ts` 中的「自動推進」describe block 及「進入/結算副本（不切 branch）」中依賴迴圈邏輯的案例）

**新增（server integration test）**：
- `/api/turn`：轉場後 SSE 即停，不繼續執行下一回合
- `/api/turn`：`suggestedActions` 為空時，done 事件補「順勢而為」
- `/api/turn`：`suggestedActions` 非空時，不補「順勢而為」

## 不變項目

- `runMainSpaceTurn`、`runDungeonTurn` 介面與行為不變
- 轉場邏輯（`enterDungeon`、`setNowActiveDungeon`、結算）不變，只是從迴圈移到 server handler
- `mode_transition` 欄位的 schema 不變
- `pendingLoreSync` 機制不變
