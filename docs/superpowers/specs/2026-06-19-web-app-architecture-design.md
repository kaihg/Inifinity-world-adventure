# 設計：網頁化遊戲引擎 + 可設定 OpenAI 相容後端

- 日期：2026-06-19
- 狀態：待 brainstorming 確認，待實作
- 前置：建立在 `2026-06-19-wiki-llm-turn-protocol-design.md`（三層模型、回合收束協議）與 `2026-06-19-resume-now-page-design.md`（`world/now.md` resume 提煉頁）之上。
- 對應實作計畫：`docs/superpowers/plans/2026-06-19-web-app-implementation.md`

## 1. 背景與要解決的問題

目前這個 repo 是「Markdown 世界狀態 + Claude Code CLI 對話」的形態：劇情靠使用者跟 LLM CLI 對話推進，狀態寫進 `world/`，git 歷史即故事版本記錄。試跑幾輪後浮現三個痛點：

1. **沒有需要行動時仍要手動輸入「繼續」**：純敘事回合（系統倒數、NPC 環境互動、過場）需要使用者每次手動 poke，體驗斷裂。
2. **每次恢復對話有落差**：雖然 `now.md` 已是 resume 入口，但「讀多少、怎麼讀」仍仰賴 LLM 自由判斷，新 session 容易漏讀或誤讀 canonical 檔，產生不一致。
3. **LLM 後端綁死、世界觀呈現有限**：CLI 對話無法集中呈現角色面板、積分、NPC 關係、副本地圖等世界觀資訊；也無法讓部署者改用自架模型節省費用。

**解法方向（已與使用者確認）**：在不動既有 Markdown 檔案架構的前提下，新增一個 **Node.js + TypeScript 的網頁服務**，把回合驅動邏輯從「LLM 自由詮釋 skill 指令」收斂成「程式碼重實作的回合引擎」，並透過 OpenAI 相容介面讓部署者自由設定 LLM 後端（含自架模型）。劇情（網頁遊玩）與開發（改 CLAUDE.md／skills／引擎本身）明確分離。

### 確認的架構決策

| 決策 | 選擇 |
|---|---|
| 執行環境 | Node.js + TypeScript |
| 引擎與 skills 關係 | 程式碼重實作引擎；skills 保留給 CLI 維護路徑 |
| Git 行為 | 每個敘事回合結束自動 commit `world/` |
| 本次產出 | 設計文件 + 實作計畫（不動程式碼） |

## 2. 不變的部分（明確排除改動）

- **`world/` 檔案架構不動**：`setting.md`、`gm-notes.md`、`journal.md`、`now.md`、`characters/*.md`、`dungeons/<id>/{wiki,secrets,runs}` 全部維持原語意與欄位。
- **三層模型不動**：raw（`journal.md`／`runs/*.md`）→ 提煉頁（`now.md`／`wiki.md`）→ 逐實體 canonical（`characters/*.md`）。引擎只是把「讀寫這三層的協議」用程式碼固化。
- **單一主角、單一世界**：網頁服務預設**單機自架、無多人/帳號系統**；想玩自己的版本仍是 fork 倉庫。多人化為非目標。
- **隱藏設定哲學不動**：`gm-notes.md`／`secrets.md` 仍由「init/enter 首次生成、不預覽、只供暗線一致」，引擎不得把未揭露內容送進前端可見回應。

> **路徑演進（已決議）**：網頁引擎是**取代** CLI skill 路徑的新遊玩面，不是長期並行。引擎開發完成後，邏輯被重實作的現有 skills（`start-story`／`enter-dungeon`／`settle-dungeon`／`roll-random`／`init-world`）即**封存**（見 plan Phase 7）。開發期間兩者暫時共存以便對照。

## 3. 整體架構

新增頂層目錄 `app/`（story runtime），與 `world/`（狀態）、`.claude/`（CLI 維護路徑）並列。

```
app/
  package.json
  .env.example              # OPENAI_BASE_URL / OPENAI_API_KEY / MODEL / PORT ...
  src/
    config.ts               # 讀 env/設定檔，集中 LLM 與引擎參數
    llm/
      client.ts             # OpenAI 相容 client（base URL 可換），streaming + tool/JSON
    engine/
      context.ts            # 狀態載入器：依「先讀 index」哲學組裝每回合 context
      turn.ts               # 回合引擎：組 prompt → 呼叫 LLM → 解析 → 落地三層 → commit
      roll.ts               # 伺服器端真隨機（roll-random 的程式碼版），可驗證、寫進 log
      router.ts             # 主空間 / 副本 模式路由（讀 now.md「進行中的副本」欄）
      dungeon.ts            # 進入/結算副本（建 branch、run log、merge）
      schema.ts             # 結構化回合輸出 schema（見 §5）
    git/
      commit.ts             # 每回合自動 commit world/；副本走 branch
    server/
      index.ts              # HTTP server（Fastify/Express）
      routes.ts             # /api/state、/api/turn(SSE)、/api/history、/api/config ...
  web/                       # 前端（Vite + React 輕量，或純 HTML）
    ...
```

### 元件職責

1. **LLM client（`llm/client.ts`）**：包一層 OpenAI 相容 client。base URL、API key、model 全部從 `config` 來，預設打 OpenAI，但部署者可指向 vLLM／Ollama（OpenAI 相容模式）／LM Studio／任何自架端點。支援 SSE streaming 與 tool-calling/JSON 結構化輸出。

2. **狀態載入器（`engine/context.ts`）**：**這是解決 resume 落差的核心**。每回合由程式碼**決定論地**載入 canonical context——固定先讀 `now.md` + `setting.md` + `characters/index.md`，再依當前在場 NPC/副本按需讀對應檔，組成穩定的 system context。不再靠 LLM 自由決定讀多少，根除「漏讀/誤讀」。

3. **回合引擎（`engine/turn.ts`）**：把「回合收束協議」固化成程式碼流程：組 prompt → 呼叫 LLM（結構化輸出）→ 解析 state deltas → 落地三層（append raw、提煉 canonical、覆寫 `now.md`）→ 自動 commit。狀態寫入由**引擎執行**（依 LLM 回傳的結構化 delta），不是 LLM 自由 freestyle markdown，強化 canonical 一致性。

4. **roll-random（`engine/roll.ts`）**：機率判定改由**伺服器端**用 `crypto`/`random` 產生並記錄，再把數值餵回 LLM 敘事。採兩階段：LLM 在結構化輸出中**宣告需要哪些判定**（命中/暴擊/隨機事件…）→ 引擎擲骰並寫進 log → LLM 依數值敘述結果。徹底根除「LLM 直接演機率」與「先編故事再湊隨機數」。

5. **模式路由（`engine/router.ts`）+ 副本（`engine/dungeon.ts`）**：讀 `now.md`「進行中的副本」欄決定走主空間或副本。進入副本 = 建 branch + run log（PR 可選，見 §7）；結算 = 提煉進 wiki + merge 回 main。對應 enter-dungeon／settle-dungeon 的程式碼版。

6. **Web server + API（`server/`）**：
   - `GET /` 服務前端。
   - `GET /api/state`：回傳 `now.md` 解析後的當前局勢 + protagonist 摘要 + 當前模式（resume 讀取路徑）。
   - `POST /api/turn`：送出玩家輸入/動作，以 SSE 串流回敘事；引擎內部視需要自動連續推進（見 §4）。
   - `GET /api/history`：近期 journal/run log。
   - `GET/POST /api/config`：LLM 端點/模型設定（或僅吃 env）。

7. **Web UI（`web/`）**：
   - 主敘事區（串流故事文字）+ 玩家輸入框 + 建議動作按鈕。
   - 側欄世界觀面板：主角狀態（積分、屬性、技能、buff/debuff）、在場 NPC、當前篇章、副本倒數、未解懸念——即「更完整世界觀與使用者操作」。
   - 設定頁：LLM 端點/模型。
   - 技術選型：**Vite + React**（已決議，狀態面板較好做）。

## 4. 自動推進設計（解決手動「繼續」）

結構化回合輸出帶一個 `awaiting_user_input: boolean` 欄位（必要時加 `suggested_actions: string[]`）：

- LLM 判斷本回合是純環境敘事/系統倒數/NPC 旁白、**不需要玩家決策**時，回 `awaiting_user_input: false`。
- 伺服器在 `/api/turn` 的 SSE 串流中**自動連續呼叫下一回合**，直到出現 `awaiting_user_input: true`（需要玩家選擇）或撞到安全上限。
- **安全機制**：單次請求最多自動推進 `AUTO_ADVANCE_MAX`（預設例如 4）回合，避免失控/無限燒 token；前端可隨時送中斷。每個自動回合一樣跑完整回合收束協議（落地三層 + commit）。

## 5. 結構化回合輸出 schema（草案）

每回合 LLM 透過 tool-calling／JSON mode 回傳：

```jsonc
{
  "narrative": "顯示給玩家的敘事散文",
  "rolls_needed": [            // 兩階段擲骰：先宣告，引擎擲完再續敘
    { "id": "hit", "desc": "技能命中判定", "type": "d100", "threshold": 65 }
  ],
  "state_changes": {          // 引擎據此寫 canonical，非 LLM 自由覆寫
    "protagonist": { "points_delta": 0, "notes": "..." },
    "npcs": [ { "id": "yeqing", "update": "..." } ],
    "wiki_reveals": [ "..." ],         // 僅已揭露，引擎仍以 secrets.md 把關
    "now": { "場景": "...", "下一步": "...", "懸念": [ "..." ] }
  },
  "mode_transition": null,    // null | "enter_dungeon" | "settle_dungeon"
  "awaiting_user_input": true,
  "suggested_actions": [ "...", "..." ],
  "commit_summary": "一句 commit message"
}
```

**模型要求（已決議：不做降級 fallback）**：結構化輸出是引擎核心契約，**要求部署者使用具備穩定 tool-calling／JSON mode 能力的模型**，不為弱模型維護「純文字抽取」降級路徑。解析失敗時引擎以明確錯誤回報（並可重試一次同一回合），而非靜默退化——保持回合落地的確定性。自架模型須先驗證其結構化輸出能力。

## 6. 劇情 / 開發分離

- `app/` = 劇情 runtime（遊玩面）；只會寫入 `world/`（與建立副本 branch），**永不**碰 `CLAUDE.md`／`.claude/skills/`／引擎自身程式碼。
- 倉庫維護（改 CLAUDE.md、調 skill、改引擎）= 開發路徑，走一般 git 流程。
- **canonical 單一來源**：網頁引擎讀寫 `world/*.md`，遵循同一套 Markdown 契約（`now.md` 欄位、回合收束三層）——契約以本設計文件與既有 spec 為單一來源。開發期間 CLI skills 暫時共存可對照，引擎完成後封存（見 Phase 7）；之後 `world/` 仍可被 Claude Code 臨時讀寫（維護用），但**正式遊玩走網頁引擎**。

## 7. Git 行為

- 每個敘事回合收束時自動 commit `world/` 變更（用 `simple-git` 或 `child_process`）；commit message 取結構化輸出的 `commit_summary`。
- 主空間：直接 commit 當前分支。
- 副本：enter 時建 `dungeon/<id>/<run-id>` branch，逐回合 commit 到該 branch；settle 時提煉進 wiki 後**本地 merge** 回 main。
- **副本不開 PR（已決議）**：網頁單機自架以「本地 branch + merge」做副本邊界，引擎不需 GitHub token。**PR 改回歸一般開發流程**（改引擎程式碼、CLAUDE.md、skills 等才開 PR），不再用 PR 承載副本劇情。

## 8. 設定 / 部署

- `.env.example`：`OPENAI_BASE_URL`、`OPENAI_API_KEY`、`MODEL`、`PORT`、`GIT_AUTHOR_NAME/EMAIL`、`AUTO_ADVANCE_MAX`。
- 啟動：`npm install && npm run dev`（dev）/ `npm run build && npm start`（prod）。
- 單機自架、預設綁 localhost、無帳號系統。多人/雲端託管為非目標。

## 9. 非目標（Non-goals）

- 多人/多主角/多世界（維持 fork 模型）。
- 帳號、登入、權限系統。
- 弱模型相容的降級/純文字抽取路徑（要求具結構化輸出能力的模型）。
- 長期維護 CLI 遊玩路徑——引擎完成後現有遊玩類 skills 封存。
- 改動 `world/` 既有檔案語意或三層模型。

## 10. 已決議事項（原待議）

1. **副本不開 PR**：本地 branch+merge；PR 回歸一般開發流程。
2. **不做弱模型降級**：結構化輸出為核心契約，要求具 tool-calling/JSON 能力的模型。
3. **前端**：Vite + React。
4. **現有 skills 封存**：引擎完成後封存遊玩類 skills（見 plan Phase 7），不做交叉引用。
