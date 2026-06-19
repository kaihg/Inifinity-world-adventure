# 網頁化遊戲引擎 Implementation Plan

> **For agentic workers:** 分階段實作，每階段可獨立交付並驗證。步驟用 checkbox（`- [ ]`）追蹤。對應設計文件：`docs/superpowers/specs/2026-06-19-web-app-architecture-design.md`。

**Goal:** 在不動 `world/` 檔案架構的前提下，新增 Node.js + TypeScript 網頁服務，把回合驅動邏輯用程式碼重實作成「回合引擎」，支援可設定的 OpenAI 相容 LLM 後端、自動推進回合、每回合自動 commit，並把劇情遊玩與倉庫開發分離。

**Architecture:** `app/` story runtime 與 `world/`、`.claude/` 並列。引擎固化三層模型與回合收束協議；狀態載入器決定論地組 context（修 resume 落差）；伺服器端 roll-random（真隨機）；結構化回合輸出帶 `awaiting_user_input` 驅動自動推進。

**Tech Stack:** Node.js + TypeScript、OpenAI 相容 SDK、SSE streaming、simple-git、Vite + React（前端）。本 repo 原無測試框架，引擎部分引入 Vitest 做最小單元測試；其餘以手動驗證/grep。

## Global Constraints

- 全程繁體中文 + 台灣用詞，禁簡體習慣用詞（含 UI 文案、commit message）。
- **不改動 `world/` 既有檔案語意與三層模型**；引擎只是讀寫既有契約。
- 網頁引擎**只寫 `world/`（與副本 branch）**，永不碰 `CLAUDE.md`／`.claude/skills/`／引擎程式碼。
- 機率判定一律走 `engine/roll.ts` 真隨機並寫 log，禁止 LLM 直接演。
- 隱藏設定（`gm-notes.md`／`secrets.md`）不得進入前端可見回應。
- 每回合收束自動 commit；commit message 用一句摘要。
- LLM 後端參數全部設定化（base URL/key/model），預設 OpenAI、可指自架。
- **不做弱模型降級**：結構化輸出為核心契約，要求具 tool-calling/JSON 能力的模型；解析失敗以錯誤回報（可重試一次），不靜默退化。
- **副本不開 PR**：本地 branch+merge；PR 回歸一般開發流程。
- 前端固定 **Vite + React**。

---

### Phase 0：專案骨架

**Files:** `app/package.json`、`app/tsconfig.json`、`app/.env.example`、`app/src/config.ts`、`app/src/server/index.ts`、`.gitignore`（加 `app/node_modules`、`app/.env`、`app/dist`）

- [ ] **Step 1:** 初始化 `app/` TS 專案（package.json scripts：`dev`/`build`/`start`/`test`），裝 server 框架、dotenv、simple-git、OpenAI SDK、Vitest。
- [ ] **Step 2:** `config.ts` 讀 env：`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`MODEL`、`PORT`、`GIT_AUTHOR_NAME/EMAIL`、`AUTO_ADVANCE_MAX`；缺值給合理預設與啟動警示。
- [ ] **Step 3:** 最小 HTTP server，`GET /api/health` 回 `{ok:true}`。
- [ ] **驗證:** `npm run dev` 後 `curl localhost:$PORT/api/health` 得 `{"ok":true}`。`.env` 不入 git。

### Phase 1：狀態載入器 + 唯讀狀態 API + 最小 UI（修 resume 落差）

**Files:** `app/src/engine/context.ts`、`app/src/server/routes.ts`、`app/web/`（最小頁面）

- [ ] **Step 1:** `context.ts`：決定論載入 `world/now.md` + `setting.md` + `characters/index.md`，解析 `now.md` 七欄位為結構物件；依「在場 NPC」按需讀對應 `characters/<id>.md`。
- [ ] **Step 2:** `GET /api/state` 回傳當前局勢 + protagonist 摘要 + 當前模式（由 `now.md`「進行中的副本」欄判定）。
- [ ] **Step 3:** 最小前端：讀 `/api/state` 顯示當前篇章/場景/在場 NPC/積分。
- [ ] **驗證:** 啟動後前端正確顯示 `world/now.md` 目前內容；改 `now.md` 重整即更新。確認載入清單固定、不依賴 LLM。

### Phase 2：LLM client + 單回合主空間敘事（無自動推進）

**Files:** `app/src/llm/client.ts`、`app/src/engine/turn.ts`、`app/src/git/commit.ts`、`app/src/server/routes.ts`

- [ ] **Step 1:** `client.ts`：OpenAI 相容 client（base URL 可換），支援 streaming chat completion。
- [ ] **Step 2:** `turn.ts`（最小版）：組 system prompt（嵌入 `context.ts` 的 canonical context + `setting.md` 規則）→ 呼叫 LLM → 取得敘事 → append 到 `world/journal.md`（帶時間戳）→ 覆寫 `now.md` 最小欄位。
- [ ] **Step 3:** `commit.ts`：commit `world/` 變更到當前分支，message 用摘要。
- [ ] **Step 4:** `POST /api/turn` 接玩家輸入，SSE 串流敘事；回合結束自動 commit。
- [ ] **驗證:** 從 UI 送一句輸入，得串流敘事；`world/journal.md` 有新段、`now.md` 被覆寫、git 有一筆 commit。

### Phase 3：結構化回合輸出 + 伺服器端 roll-random + 三層落地

**Files:** `app/src/engine/schema.ts`、`app/src/engine/roll.ts`、`app/src/engine/turn.ts`（升級）、`app/src/engine/__tests__/*`

- [ ] **Step 1:** `schema.ts`：定義結構化回合輸出（`narrative`/`rolls_needed`/`state_changes`/`mode_transition`/`awaiting_user_input`/`suggested_actions`/`commit_summary`），用 tool-calling 或 JSON mode 取得。
- [ ] **Step 2:** `roll.ts`：`crypto` 真隨機，支援 d100/門檻判定，回傳值寫進 raw log（可驗證）。
- [ ] **Step 3:** `turn.ts` 升級為兩階段：LLM 宣告 `rolls_needed` → 引擎擲骰 → 回灌 LLM 續敘 → 引擎依 `state_changes` **決定論地**落地三層（append raw、提煉 `characters/*.md`/`wiki.md`、覆寫 `now.md` 七欄位），嚴守 `secrets.md` 不外洩。
- [ ] **Step 4:** 解析失敗處理：以明確錯誤回報並可對同一回合重試一次，不靜默退化（無降級路徑）。
- [ ] **Step 5:** Vitest：roll 分佈/門檻、schema 解析、解析失敗錯誤路徑單元測試。
- [ ] **驗證:** 觸發一次機率情境，log 內有可驗證骰值；canonical 檔依 delta 更新；`npm test` 綠燈。

### Phase 4：自動推進回合（解決手動「繼續」）

**Files:** `app/src/server/routes.ts`、`app/src/engine/turn.ts`

- [ ] **Step 1:** `/api/turn` 內迴圈：當回合回 `awaiting_user_input:false` 時自動續推下一回合，串流逐回合敘事，直到 `true` 或達 `AUTO_ADVANCE_MAX`。
- [ ] **Step 2:** 前端支援中斷自動推進；每自動回合仍跑完整收束 + commit。
- [ ] **驗證:** 純環境/倒數情境下無需輸入即連續推進並停在需要決策處；不超過上限。

### Phase 5：副本模式（mode，非 branch）

**Files:** `app/src/engine/dungeon.ts`、`app/src/engine/turn.ts`（mode-aware 路由）

> **架構修正**：副本不切 git branch，而是 `now.md` 驅動的「模式」。所有回合 commit 當前分支；raw/提煉分層靠檔案。

- [ ] **Step 1:** `dungeon.ts`：`parseActiveDungeon`/`formatActiveDungeon`、`nextRunId`、`appendRun`（raw → `runs/<run-id>.md`）、`loadDungeonLore`（讀 wiki+secrets）。
- [ ] **Step 2:** `enterDungeon`：建 `runs/<run-id>.md`（含進入時間/角色摘要/目標）、首次進入用 LLM 生成 `secrets.md`（不外洩、可注入測試）、設 `now.md` 進行中的副本欄。
- [ ] **Step 3:** 副本回合：載入 wiki+secrets 進 prompt（嚴守 secrets）；raw → `runs/<run-id>.md`；提煉 `wiki_reveals` → `wiki.md`；now 七欄/積分照舊。
- [ ] **Step 4:** `settleDungeon`：提煉 run→wiki、更新 characters/index、清 `now.md` 進行中的副本欄回主空間（死亡也走此流程）。
- [ ] **Step 5:** `runTurnLoop` mode-aware：依 `now.md` 模式 dispatch；`mode_transition` enter/settle 觸發切換。
- [ ] **驗證:** 完整跑「進副本→數回合→結算回主空間」，runs/wiki/now 正確、secrets 不外洩；全程不切 branch。

### Phase 6：完整世界觀 UI

**Files:** `app/web/`（狀態面板、NPC 面板、動作按鈕、設定頁）

- [ ] **Step 1:** 側欄面板：主角積分/屬性/技能/buff、在場 NPC、當前篇章、副本倒數、未解懸念。
- [ ] **Step 2:** 主敘事區串流 + 建議動作按鈕（`suggested_actions`）+ 自由輸入。
- [ ] **Step 3:** 設定頁：LLM base URL/model/key（寫回 `.env` 或 runtime config）。
- [ ] **驗證:** 一輪遊玩中面板即時反映 canonical 變化；切換 LLM 端點生效。

### Phase 7：封存現有 skills + 文件固化

**Files:** `CLAUDE.md`、`.claude/skills/`（封存遊玩類 skills）、`app/README.md`

- [ ] **Step 1:** 封存邏輯已被引擎重實作的遊玩類 skills（`start-story`／`enter-dungeon`／`settle-dungeon`／`roll-random`／`init-world`）——移到 `archives/skills/<date>/` 或加 deprecated 標記，並移除/調整 `.claude/settings.json` 中對應的 Stop hook（改由引擎負責回合落地）。
- [ ] **Step 2:** `CLAUDE.md` 大改：把「核心循環」「目錄結構」「關鍵約定」更新為**網頁引擎路徑**——`app/` 角色、劇情/開發分離、副本走本地 branch+merge（不開 PR）、引擎只寫 `world/` 的邊界、skills 已封存。
- [ ] **Step 3:** `app/README.md`：安裝/設定/啟動、如何指向自架模型。
- [ ] **驗證:** 新讀者能從 CLAUDE.md 理解唯一遊玩路徑（網頁引擎）與開發邊界；README 能照著跑起來；封存的 skills 不再被 Claude Code 當作遊玩入口。

---

## 階段相依與交付節奏

- Phase 0–1 可先交付「唯讀 resume 面板」（已修一半落差，零 LLM 成本即可驗證）。
- Phase 2–4 為核心引擎（可遊玩主空間 + 自動推進）。
- Phase 5 補齊副本閉環。
- Phase 6–7 完善體驗與文件。

每階段結束即 commit/push，逐階段請使用者驗收，不一次性巨量交付。
