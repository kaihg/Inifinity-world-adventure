# 網頁化遊戲引擎 Implementation Plan

> **For agentic workers:** 分階段實作，每階段可獨立交付並驗證。步驟用 checkbox（`- [ ]`）追蹤。對應設計文件：`docs/superpowers/specs/2026-06-19-web-app-architecture-design.md`。

**Goal:** 在不動 `world/` 檔案架構的前提下，新增 Node.js + TypeScript 網頁服務，把回合驅動邏輯用程式碼重實作成「回合引擎」，支援可設定的 OpenAI 相容 LLM 後端、自動推進回合、每回合自動 commit，並把劇情遊玩與倉庫開發分離。

**Architecture:** `app/` story runtime 與 `world/`、`.claude/` 並列。引擎固化三層模型與回合收束協議；狀態載入器決定論地組 context（修 resume 落差）；伺服器端 roll-random（真隨機）；結構化回合輸出帶 `awaiting_user_input` 驅動自動推進。

**Tech Stack:** Node.js + TypeScript、OpenAI 相容 SDK、SSE streaming、simple-git、Vite + React（前端，可改純 HTML）。本 repo 原無測試框架，引擎部分引入 Vitest 做最小單元測試；其餘以手動驗證/grep。

## Global Constraints

- 全程繁體中文 + 台灣用詞，禁簡體習慣用詞（含 UI 文案、commit message）。
- **不改動 `world/` 既有檔案語意與三層模型**；引擎只是讀寫既有契約。
- 網頁引擎**只寫 `world/`（與副本 branch）**，永不碰 `CLAUDE.md`／`.claude/skills/`／引擎程式碼。
- 機率判定一律走 `engine/roll.ts` 真隨機並寫 log，禁止 LLM 直接演。
- 隱藏設定（`gm-notes.md`／`secrets.md`）不得進入前端可見回應。
- 每回合收束自動 commit；commit message 用一句摘要。
- LLM 後端參數全部設定化（base URL/key/model），預設 OpenAI、可指自架。

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
- [ ] **Step 4:** 解析失敗的降級路徑（純敘事 + 最小 now.md 覆寫，log 標記降級）。
- [ ] **Step 5:** Vitest：roll 分佈/門檻、schema 解析、降級路徑單元測試。
- [ ] **驗證:** 觸發一次機率情境，log 內有可驗證骰值；canonical 檔依 delta 更新；`npm test` 綠燈。

### Phase 4：自動推進回合（解決手動「繼續」）

**Files:** `app/src/server/routes.ts`、`app/src/engine/turn.ts`

- [ ] **Step 1:** `/api/turn` 內迴圈：當回合回 `awaiting_user_input:false` 時自動續推下一回合，串流逐回合敘事，直到 `true` 或達 `AUTO_ADVANCE_MAX`。
- [ ] **Step 2:** 前端支援中斷自動推進；每自動回合仍跑完整收束 + commit。
- [ ] **驗證:** 純環境/倒數情境下無需輸入即連續推進並停在需要決策處；不超過上限。

### Phase 5：副本模式（enter / run log / settle / 路由）

**Files:** `app/src/engine/router.ts`、`app/src/engine/dungeon.ts`、`app/src/git/commit.ts`（branch 支援）

- [ ] **Step 1:** `router.ts`：依 `now.md`「進行中的副本」欄路由主空間/副本；mode_transition 觸發切換。
- [ ] **Step 2:** `dungeon.ts` enter：建 `dungeon/<id>/<run-id>` branch、建 `runs/<run-id>.md`；首次進入該 dungeon 生成 `secrets.md`（不外洩）。
- [ ] **Step 3:** 副本回合 commit 到 dungeon branch；settle：提煉 run log 進 `wiki.md` + 更新 character/index + merge 回 main。
- [ ] **Step 4:** PR 設定化（有 GitHub token 才開 PR，否則本地 branch+merge）——對應 spec §10 待議。
- [ ] **驗證:** 完整跑一次「進副本→數回合→結算合併」，branch/wiki/now 路由與 CLI 路徑語意一致。

### Phase 6：完整世界觀 UI

**Files:** `app/web/`（狀態面板、NPC 面板、動作按鈕、設定頁）

- [ ] **Step 1:** 側欄面板：主角積分/屬性/技能/buff、在場 NPC、當前篇章、副本倒數、未解懸念。
- [ ] **Step 2:** 主敘事區串流 + 建議動作按鈕（`suggested_actions`）+ 自由輸入。
- [ ] **Step 3:** 設定頁：LLM base URL/model/key（寫回 `.env` 或 runtime config）。
- [ ] **驗證:** 一輪遊玩中面板即時反映 canonical 變化；切換 LLM 端點生效。

### Phase 7：文件與邊界固化

**Files:** `CLAUDE.md`、`.claude/skills/*/SKILL.md`（加交叉引用）、`app/README.md`

- [ ] **Step 1:** `CLAUDE.md` 增「網頁引擎路徑」章節：`app/` 角色、劇情/開發分離、雙路徑共用 canonical、引擎只寫 `world/` 的邊界。
- [ ] **Step 2:** 相關 skill 文件加一句交叉引用，避免兩邊協議漂移。
- [ ] **Step 3:** `app/README.md`：安裝/設定/啟動、如何指向自架模型。
- [ ] **驗證:** 新讀者能從 CLAUDE.md 理解兩條遊玩路徑與邊界；README 能照著跑起來。

---

## 階段相依與交付節奏

- Phase 0–1 可先交付「唯讀 resume 面板」（已修一半落差，零 LLM 成本即可驗證）。
- Phase 2–4 為核心引擎（可遊玩主空間 + 自動推進）。
- Phase 5 補齊副本閉環。
- Phase 6–7 完善體驗與文件。

每階段結束即 commit/push，逐階段請使用者驗收，不一次性巨量交付。
