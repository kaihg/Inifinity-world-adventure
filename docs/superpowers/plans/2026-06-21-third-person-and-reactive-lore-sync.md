# 第三人稱鐵則 + 場景/技能 lore + 反應式文件同步 Implementation Plan

> 對應設計文件：`docs/superpowers/specs/2026-06-21-third-person-and-reactive-lore-sync-design.md`

**Goal：**
1. 主敘事 prompt 加第三人稱鐵則。
2. `lore.ts` 新增 `"locations"` 分類，`schema.ts` 新增 `location_pickups`/`location_reveals`/`skill_pickups`/`skill_reveals`。
3. 把單一 control call 拆成 Layer 2（fast-control，blocking，決定 done event）+ Layer 3（reactive-lore-sync：npc/item/location/skill/wiki + recall 重建索引，不卡 SSE，靠 `pendingLoreSync` promise 接力確保下一回合前完成）。

**Tech Stack：** Node.js + TypeScript、Zod、Vitest、Fastify SSE。

## Global Constraints

- 不改變骰值機制（`roll.ts`）、`TurnControlSchema` 既有欄位語意、raw 層落地時機。
- 不引入 worker_threads / job queue；`pendingLoreSync` 只是 process 內的 promise 接力。
- Layer 3 任一步驟失敗只 `log.warn`，不可讓 `pendingLoreSync.promise` reject（否則會讓下一回合的 await 拋錯）。
- 全程繁體中文 prompt 文案，沿用既有風格；commit message 提到 lore 文件只寫事實，不寫具體內容。

---

## To-do Checklist

### Task 1 — 第三人稱鐵則（低風險，先做）
- [x] `buildMainSpaceMessages` 鐵則加第三人稱規則
- [x] `buildDungeonMessages` 鐵則加第三人稱規則
- [x] `turn.test.ts`：兩個 prompt 各補一條斷言（system 內容包含「第三人稱」關鍵字）
- [x] 跑 `npx vitest run src/engine/turn.test.ts`，確認通過
- [x] Commit：`feat(prompt): 敘事鐵則加第三人稱規定`

### Task 2 — `lore.ts` 新增 `locations` 分類
- [x] `LoreCategory` 加 `"locations"`
- [x] `lore.test.ts`：複製既有 items 測試模式，新增 `locations` 的 `loadLore`/`ensureSecrets`/`appendLoreReveals` 測試
- [x] 跑測試確認通過
- [x] Commit：`feat(lore): 新增 locations 分類`

### Task 3 — schema 新增場景/技能欄位
- [x] `StateChangesSchema` 新增 `location_pickups`/`location_reveals`/`skill_pickups`/`skill_reveals`（型別對齊既有 `item_pickups`/`item_reveals`）
- [x] `schema.test.ts` 補對應解析測試
- [x] `CONTROL_FORMAT_BLOCK`（之後會搬進 Layer 3 prompt）文案補上新欄位說明
- [x] 跑測試確認通過
- [x] Commit：`feat(schema): 新增場景/技能 pickups/reveals 欄位`

### Task 4 — 把 `applyItemPickups`/`appendLoreReveals` 呼叫點參數化
- [x] 把 `turn.ts` 內 `applyItemPickups` 改成接受 `category: LoreCategory` 參數（現有道具邏輯不變，只是不再硬寫 `"items"`），新增等價的 `applyLorePickups(deps, settingText, category, pickups, log)`
- [x] 確認道具現有測試仍通過（純重構，行為不變）
- [x] Commit：`refactor(turn): applyItemPickups 參數化為 applyLorePickups`

### Task 5 — 拆 Layer 2 / Layer 3 prompt 建構函式
- [x] 把現有 `buildControlMessages` 拆成 `buildFastControlMessages`（欄位：now/protagonist/rolls/mode_transition/awaiting_user_input/suggested_actions/commit_summary）與 `buildLoreSyncMessages`（欄位：npc_updates/item_*/location_*/skill_*/wiki_reveals）
- [x] 兩者皆讀完整敘事散文 + canonical 狀態；`buildLoreSyncMessages` 不需要 `existingDungeonIds`/`mode_transition` 相關欄位
- [x] `turn.test.ts`：兩個建構函式各自的純函式測試
- [x] 跑測試確認通過（此時 `runTurnCore` 還沒接線，預期 typecheck 暫時不過，先確認單檔測試）
- [x] Commit：`feat(turn): 拆 buildFastControlMessages / buildLoreSyncMessages`

### Task 6 — `TurnDeps` 新增 `loreClient` + `pendingLoreSync` handle
- [x] `TurnDeps` 加 `loreClient?: LlmClient`（未設定退回 `controlClient` 退回 `client`）
- [x] 新增 `PendingLoreSync` 型別與簡單實作（一個 `{ promise: Promise<void> | null }` 可變物件 + helper），放在 `turn.ts` 或新檔 `lore-sync.ts`
- [x] `TurnDeps` 加 `pendingLoreSync?: PendingLoreSync`
- [x] 單元測試：確認「永遠 resolve」語意（傳入會 reject 的 promise，包裝後仍 resolve，並記一筆 warn）
- [x] Commit：`feat(turn): 新增 loreClient 與 pendingLoreSync handle`

### Task 7 — `runTurnCore` 拆三層
- [x] `runTurnCore` 的 control 抽取改呼叫 `buildFastControlMessages`，落地範圍縮小到 now/主角/rolls/commit/done（既有降級邏輯不變）
- [x] 新增 `runLoreSync(...)`：呼叫 `buildLoreSyncMessages` → 解析 → 落地 npc/item/location/skill/wiki reveals → recall 重建索引（觸及檔案清單補 locations/skills）→ commit 一次
- [x] `runMainSpaceTurn`/`runDungeonTurn`：
  - 回合開始先 `await deps.pendingLoreSync?.promise`
  - `runTurnCore`（Layer1+2）yield 完 `done` 後，呼叫端立刻把 `runLoreSync(...)` 包裝、不 await，寫回 `deps.pendingLoreSync`
- [x] `turn.test.ts`：
  - 用「卡住的 fake loreClient」斷言 `done` event 在 Layer 3 resolve 前就已 yield
  - 兩次連續呼叫同一 `deps`（共用 `pendingLoreSync`），驗證第二次呼叫前已等到第一次 Layer 3 落地的檔案
  - Layer 3 失敗（loreClient 拋錯）：下一回合仍正常開始、不拋錯
- [x] 既有完整回合測試（now/積分/wiki/mode_transition/auto-advance）改用新的兩段 control mock，確認全部維持綠燈
- [x] 跑 `npx vitest run src/engine/turn.test.ts`，確認通過
- [x] Commit：`feat(turn): runTurnCore 拆 Layer2 fast-control / Layer3 reactive-lore-sync`

### Task 8 — server 接線
- [x] `config.ts` 新增 `lore?: { baseUrl; model }`（同 `control` 模式）
- [x] `app.ts` 建立 `loreClient`，建立 per-session `pendingLoreSync` 實例並傳入 `TurnDeps`
- [x] `app.test.ts`：SSE 測試補一個案例，確認 response 在 Layer 2 完成即關閉（不等卡住的 fake loreClient）
- [x] 跑全部測試 + typecheck + build
- [x] Commit：`feat(server): 接線 loreClient 與 pendingLoreSync`

### Task 9 — 收尾驗證
- [ ] `npm run typecheck && npm test && npm run build`（在 `app/` 下）
- [ ] 手動跑一次 `npm run dev`，跑一個回合，確認：建議動作即時出現、稍後 wiki/角色檔案/recall 索引確實補上、git log 看到兩次 commit（fast-control + lore-sync）
- [ ] Commit（若有遺漏的小修正）

---

## 已知取捨 / 待確認

- Layer 3 失敗時前端看不到 warning（連線已關閉），只進 server log——如果之後想讓玩家也能感知「補完中/補完失敗」，需要額外的狀態查詢端點，本次不做（見設計文件「範圍外」）。
- 每回合可能變成 2 次 git commit（fast-control 一次、lore-sync 一次）；lore-sync 沒有東西要落地時應該跳過 commit（避免空 commit）。
