# turn.ts 拆分重構 design

## 背景

`app/src/engine/turn.ts` 目前 1045 行，是 `engine/` 目錄裡最大的檔案（對應的 `turn.test.ts` 也有 1157 行）。內容混雜了七種職責：

1. Prompt 建構（`buildMainSpaceMessages`/`buildDungeonMessages`/`buildFastControlMessages`/`buildLoreSyncMessages`/`canonicalBlock` 等純函式）
2. Lore 單筆重寫邏輯（`callLoreRewrite`/`rewriteLoreEntity`/`generateItemSecrets`）
3. Layer 3（reactive-lore-sync）編排（`runLoreSync`/`scheduleLoreSync`/`trackLoreSync`/`syncCharacterIndexStatus`/`reindexTouchedFiles`）
4. Layer 1+2（敘事 + fast-control）回合核心（`runTurnCore`）
5. Pre-pass / recall 輔助區塊（`runPrePassBlock`/`runRecallBlock`）
6. 副本轉場小工具（`generateSecrets`/`setNowActiveDungeon`）
7. 對外入口與主流程編排（`runMainSpaceTurn`/`runDungeonTurn`/`runTurnLoop`）

痛點：職責混雜難測試、檔案太長難導航。本次重構**只搬移現有程式碼到新檔案邊界，不改變任何行為**（純粹拆檔 + 對應拆測試），不引入新功能或新抽象。

## 目錄結構

新建 `app/src/engine/turn/` 子目錄，與 `context.ts`、`dungeon.ts` 等現有檔案平行：

```
engine/turn/
  types.ts              # TurnDeps, TurnEvent, PendingLoreSync, TurnPlan（共用型別，零依賴）
  shared.ts             # todayISO, deriveSummary, readBestEffort
  prompts.ts            # build*Messages 系列 + canonicalBlock + FAST_CONTROL_FORMAT_BLOCK/LORE_SYNC_FORMAT_BLOCK
  lore-rewrite.ts        # callLoreRewrite / rewriteLoreEntity / generateItemSecrets / ENTITY_CATEGORY_* / ITEM_ID_RE / LoreRewriteResult
  lore-sync.ts           # Layer 3：runLoreSync / scheduleLoreSync / trackLoreSync / syncCharacterIndexStatus / reindexTouchedFiles
  turn-core.ts           # Layer 1+2：runTurnCore
  context-blocks.ts      # runPrePassBlock / runRecallBlock / DEFAULT_RECALL_TOP_K
  dungeon-transition.ts  # generateSecrets / setNowActiveDungeon / AUTO_CONTINUE_INPUT
  index.ts               # TurnPlan 組裝 + runMainSpaceTurn / runDungeonTurn / runTurnLoop（唯一對外入口）
```

舊的 `engine/turn.ts` 整個刪除，不保留 barrel re-export。

## 依賴方向（單向、無循環）

```
types.ts ──────────────┬─────────────┬─────────────┬─────────────┐
  ▲                     │             │             │             │
  │                  prompts.ts   shared.ts     turn-core.ts  context-blocks.ts
  │                     │             ▲             │             │
  │                     ▼             │             │             │
  │              lore-rewrite.ts ─────┘             │             │
  │                     │                            │             │
  │                     ▼                            │             │
  │               lore-sync.ts                       │             │
  │                     │                            │             │
  │              dungeon-transition.ts                │             │
  │                     │                            │             │
  └─────────────────────┴────────────────────────────┴─────────────┘
                                index.ts
```

- `types.ts`/`shared.ts`：純型別與小工具，不依賴其他 turn 子模組。
- `prompts.ts`：依賴 `types.ts`（GameState 等）與 `../context.js`/`./schema.js`，不依賴其他 turn 子模組。
- `lore-rewrite.ts`：依賴 `types.ts`、`shared.ts`。
- `lore-sync.ts`：依賴 `lore-rewrite.ts`、`types.ts`、`shared.ts`。
- `turn-core.ts`：依賴 `types.ts`、`shared.ts`。
- `context-blocks.ts`：依賴 `types.ts`（不依賴 prompts/lore，只產生字串區塊給 index.ts 組 prompt 用）。
- `dungeon-transition.ts`：依賴 `types.ts`、`../dungeon.js`。
- `index.ts`：依賴以上全部，是唯一握有「回合主流程怎麼跑」決策邏輯的檔案——其餘模組都是被動零件，彼此不互相呼叫（除了 lore-sync 依賴 lore-rewrite）。

## 主流程控管（index.ts）

```
runMainSpaceTurn(deps, input)
  1. await pendingLoreSync
  2. loadState + 讀 setting.md
  3. context-blocks.runPrePassBlock / runRecallBlock → intentsBlock/recallBlock
  4. 用 prompts.ts 的 build*Messages 組出 TurnPlan
  5. turn-core.runTurnCore(plan) → Layer1+2，yield delta/done
  6. lore-sync.scheduleLoreSync(plan) → Layer3，不卡 done event

runDungeonTurn(deps, input)
  同上，多帶 dungeonId/wiki/secrets

runTurnLoop(deps, input, maxAuto)
  依 now.md 的 mode dispatch 到 runMainSpaceTurn/runDungeonTurn，
  讀 done event 的 mode_transition 決定要不要呼叫 dungeon-transition.ts
  （進副本/結算副本），並處理 awaiting_user_input 的自動推進迴圈
```

## 外部 import 變更

唯一外部消費者是 `app/src/server/app.ts`：

```diff
- import { runTurnLoop, type PendingLoreSync } from "../engine/turn.js";
+ import { runTurnLoop, type PendingLoreSync } from "../engine/turn/index.js";
```

## 測試拆分

`turn.test.ts`（1157 行）依同樣邊界拆成對應的 `.test.ts`，與被測模組放在同一目錄：

```
engine/turn/prompts.test.ts            # buildMainSpaceMessages / buildDungeonMessages / buildFastControlMessages / buildLoreSyncMessages
engine/turn/lore-rewrite.test.ts        # callLoreRewrite / rewriteLoreEntity 等（若原測試有覆蓋）
engine/turn/lore-sync.test.ts           # runLoreSync / trackLoreSync
engine/turn/turn-core.test.ts           # runTurnCore
engine/turn/context-blocks.test.ts      # runPrePassBlock / runRecallBlock（若原測試有覆蓋）
engine/turn/dungeon-transition.test.ts  # 進/結算副本相關（若原測試有覆蓋）
engine/turn/index.test.ts               # runMainSpaceTurn / runDungeonTurn / runTurnLoop（整合測試）
```

每個新測試檔直接從對應模組 import（例如 `prompts.test.ts` 從 `./prompts.js` import `buildMainSpaceMessages`），不經由 `index.ts` re-export。實際拆分時以原 `turn.test.ts` 的 `describe` 區塊為單位對應搬移，搬完逐一跑 `npm test` 確認行為不變。

## 驗收標準

- `engine/turn.ts`、`engine/turn.test.ts` 不存在，內容已搬移到 `engine/turn/` 下對應檔案。
- `npm run build`（tsc）與 `npm test` 全綠，行為與拆分前一致（純結構重構，不改邏輯）。
- `server/app.ts` 的 import 路徑已更新。
- 無循環依賴（依上方依賴圖）。
- 每個新檔案 < 400 行（`index.ts` 可視組裝複雜度放寬，但仍應遠低於原 1045 行）。

## 範圍外

- 不變更任何回合邏輯、prompt 內容、或對外行為。
- 不重構 `character-pre-pass.ts`、`dungeon.ts`、`context.ts` 等已存在的其他引擎模組。
- 不新增功能或抽象層；純粹依現有職責邊界搬移程式碼。
