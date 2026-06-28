# Opening Turn on Init — Design Spec

**日期：** 2026-06-27

## 問題

世界初始化完成後，玩家進入主畫面時：
- `now.md` 是靜態佔位（`initialNow()`，非 LLM 生成）
- `lastTurn` 為 `null`，沒有 `suggestedActions`
- 玩家必須自己輸入第一個動作，對初始使用者不友善

## 目標

1. 初始化完成後自動執行一次「opening 回合」，讓開場敘事串流呈現給玩家
2. Opening 回合完全走現有 turn pipeline（零新增路徑），`now.md` 正確初始化，`suggestedActions` 隨狀態一起回傳
3. `opening.md` 從靜態寫作骨架升格為 opening 回合的 Layer 1 system prompt spec，可隨時調整內容而不動程式碼

## 不在範圍內

- 修改 `/api/world/init` 端點或 `world-ops.ts`
- 修改 `/api/turn` 端點或 turn pipeline
- 為 opening 回合新增任何特殊判斷路徑（turn pipeline 完全不感知「這是 opening」）

---

## 設計

### 總覽

三個獨立改動，互不耦合：

1. **`opening.md` 升格**：改寫成 opening 回合的 Layer 1 system prompt spec
2. **Context loader 注入**：`journal.md` 只有標題行時，自動注入 `opening.md` 到 context
3. **前端自動觸發**：`initWorld()` 完成後前端自動呼叫 `streamTurn("")`

---

### 1. `opening.md` 升格

從「寫作骨架」改為**opening 回合的 Layer 1 system prompt 指引**。

內容格式：直接的敘事指引，例如「依 setting.md 與 protagonist.md，以第三人稱敘述主角被拉入主神空間的過程……」。引擎讀出來當 system message 注入，不再用它生成靜態文字寫進 journal。

---

### 2. Context loader：opening 注入邏輯

`app/src/engine/context.ts` 加一個判斷：

```
讀 journal.md
若 journal.md 只有標題行（無任何 ## 日期段落）：
  讀 opening.md
  注入到 system prompt（作為額外 context，不取代現有 context 結構）
```

**判斷條件**：`journal.md` 是否只有標題行（即 `# 主空間日誌` 後無任何 `##` 段落）——決定論的機器可判斷條件，不依賴模型行為。

Opening turn 完成後 journal.md 會有 append 的段落，後續回合條件不再成立，自動停止注入。

---

### 3. 前端：post-init 自動觸發

`WorldSetupWizard.tsx`（或呼叫端）：

```
initWorld(body) 完成 → onDone(state) → 自動呼叫 streamTurn("")
```

前端進入主畫面後立刻開始串流 opening turn，走現有 SSE 流程（打字機 + suggestedActions chips）。玩家看到的體驗：init 完成 → 開場敘事串流出現 → 出現 action chips → 可以開始遊玩。

`streamTurn("")` 的空字串 input 對 turn pipeline 完全透明，context loader 注入的 opening.md 會讓模型知道要做什麼。

---

## 資料流

```
POST /api/world/init
  └─ 生成 setting / protagonist / gm-notes
  └─ 寫 now.md（initialNow）、journal.md（標題行）
  └─ commit world/
  └─ loadState() → GameState（lastTurn = null）
  └─ 200 GameState

前端 onDone(state)
  └─ 自動 POST /api/turn { input: "" }
       └─ context.ts：journal.md 只有標題行 → 注入 opening.md
       └─ Layer 1：opening 敘事串流
       └─ Layer 2：fast-control → now 欄位 + suggestedActions
       └─ Layer 3：lore-sync
       └─ 落地：append journal.md、覆寫 now.md、commit world/
       └─ done event：narrative + suggestedActions
```

---

## 錯誤處理

Opening turn 失敗（SSE 回傳 `error` 事件）時，前端現有錯誤處理即可：顯示錯誤訊息，玩家可手動輸入第一個動作。不需要特殊處理。

---

## 測試重點

- Context loader：`journal.md` 只有標題行時，context 中包含 `opening.md` 內容
- Context loader：`journal.md` 有段落時，不注入 `opening.md`
- 前端：`initWorld()` 完成後自動觸發 `streamTurn("")`
- 前端：opening turn 的 done event 帶 `suggestedActions`，chips 正常渲染
