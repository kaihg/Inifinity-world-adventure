# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 項目定位

這個 repo 是一個**「無限恐怖」類型小說的文本保存站與遊玩引擎**：單一主角、單一世界，所有世界狀態、角色檔案、副本記錄都以 Markdown 保存在倉庫裡，**git 歷史本身就是故事的版本記錄**。

「無限恐怖」設定：主角進入由「主神/系統」掌控的空間，反覆進出「副本」執行任務賺取積分，用積分兌換能力成長，直到通關或死亡。具體規則由 `world/setting.md` 定義，**不要憑空套用某部小說的設定，一切以倉庫裡實際寫的規則為準**。

**遊玩透過 `app/` 網頁引擎**（Node.js + TypeScript）：把回合驅動邏輯用程式碼實作成「回合引擎」，支援可設定的 OpenAI 相容後端（含自架模型）、自動推進回合、每回合自動 commit。設計見 `docs/superpowers/specs/2026-06-19-web-app-architecture-design.md`。

> **歷史備註**：早期靠 `.claude/skills/`（`start-story`/`enter-dungeon`/`settle-dungeon`/`roll-random`/`init-world`）+ Claude Code 對話遊玩；這些 skill 的邏輯已由引擎重實作，現已封存於 `archives/skills/2026-06-19/`，不再是遊玩入口。**Claude Code CLI 現在的角色是「開發/維護」**（改引擎、改這份 CLAUDE.md、調 world/ 內容），不是遊玩。

## 核心循環（引擎）

1. **世界狀態**存在 `world/`，是當前 lifetime 的唯一真相來源（canonical truth）。引擎與任何維護對話都讀寫這同一份。
2. **resume 讀 `world/now.md`**（覆寫式「當前局勢」快照），不讀 `journal.md`。引擎每回合用**狀態載入器**決定論地固定載入 `now.md` + `setting.md` + `characters/index.md`，消除「讀多少」的落差。
3. **回合**：引擎組 prompt → 串流 LLM → 解析結構化輸出（`===STATE===` sentinel 後接 JSON 控制區塊）→ 決定論落地三層（raw append、提煉 canonical、覆寫 `now.md`）→ 每回合自動 commit `world/`。機率判定由**伺服器端真隨機**預擲骰池並寫進 log。
4. **模式（不是 branch）**：`now.md`「進行中的副本」欄決定主空間 vs 副本回合。raw 層主空間記到 `world/journal.md`、副本記到 `dungeons/<id>/runs/<run-id>.md`。
5. **自動推進**：結構化輸出的 `awaiting_user_input=false`（純環境/系統旁白/NPC 自行動作）時，伺服器自動接續下一回合，直到需要玩家決定、觸發轉場、或達 `AUTO_ADVANCE_MAX`。消滅手動「繼續」。
6. **進/結算副本**由結構化輸出的 `mode_transition`（`enter_dungeon`/`settle_dungeon`）驅動。進入副本是**半強制**的：依 `setting.md`，系統倒數到/強制傳送時，模型自己回 `enter_dungeon`。進入時建 run log、首次生成 `secrets.md`、設 `now.md` 副本欄；結算時提煉 run→wiki、清 `now.md` 副本欄回主空間。**死亡也走結算**（新手保護等後果由結算依 `setting.md` 規則處理），全程不切 git branch、commit 當前分支。
7. **世界重置**目前沒有引擎入口（舊 `init-world` 已封存）；如需重開，手動把 `world/` 封存到 `archives/<timestamp>/` 再重建。

## 目錄結構

```
world/
  setting.md              # 玩家可見：主神表面規則、世界基調、當前篇章、新手保護條款——敘事必須嚴格遵守
  gm-notes.md              # 劇透文件：主神真實動機、世界真相、暗線，僅供保持一致，不可提前揭露
  journal.md              # 主空間 raw 層：append-only、帶時間戳的原始時間線（與副本 runs/*.md 對稱）
  now.md                  # 提煉頁：覆寫式「當前局勢」快照，resume 入口；讀這份接劇情，不讀 journal.md
  characters/
    index.md               # 輕量角色索引（先讀這個，不要一次讀全部角色檔案）
    protagonist.md          # 主角：積分、屬性、技能、物品、buff/debuff
    <npc-id>.md             # 重要 NPC/隊友/敵人檔案，隨故事持續更新
  dungeons/
    <dungeon-id>/
      wiki.md               # 該副本已揭露的累積知識（地圖/機關/規則），多次進入間延續
      secrets.md            # 劇透文件：該副本真正的機關原理/NPC真實動機，首次進入時生成一次
      runs/<run-id>.md       # 單次進入的原始 log，append-only（不再對應 branch/PR）
archives/
  <timestamp>/world/...      # 重置前的整份世界快照，只讀
  skills/2026-06-19/...       # 已封存的舊遊玩類 skills（歷史參考，不再使用）
app/                           # 網頁引擎（Node.js + TypeScript，唯一遊玩路徑）
  src/
    config.ts                  # LLM 後端等設定（OPENAI_BASE_URL/MODEL/HOST/DEBUG/RECALL_*…），可指自架，僅由後端 .env 控制
    llm/client.ts              # OpenAI 相容串流 client（介面化、可換端點）
    engine/                    # context（載入）、turn（回合/自動推進/模式路由，含每回合語意索引重建）、dungeon（副本，非 branch）、schema、roll、stream-split、journal、now
    recall/                    # 語意檢索（本地嵌入 + vectra 向量索引）：每回合以玩家輸入檢索相關片段注入 prompt，唯讀不影響落地；只負責「讀」，「寫」仍走 engine 的結構化輸出 pipeline
    git/commit.ts              # 每回合自動 commit world/
    server/                    # Fastify：/api/state、/api/turn(SSE)、靜態前端
  .recall-index/                # 語意索引快取（derived cache，RECALL_ENABLED=true 時建立，不進 git，可隨時刪除重建）
  web/                         # 前端（Vite + React）：狀態/NPC 面板、串流劇情、建議動作
  vite.config.ts               # 前端 build/dev（dev 跑 5174 proxy /api 到後端 5173）
  .env.example                 # 設定範本
.github/workflows/
  settle-on-merge.yml          # legacy：舊 PR/branch 副本流程的結算提醒；新架構副本不切 branch，已不會被遊玩觸發
```

## 劇情 / 開發分離

- **`app/` 是劇情遊玩面**：引擎只寫 `world/`，**永不**碰 `CLAUDE.md`／`app/` 程式碼／設定。
- **開發/維護**（改引擎、改 CLAUDE.md、手動調 `world/` 內容、archives 整理）走一般 git/PR 流程，由 Claude Code CLI 或其他工具進行；不要代入主神/系統的劇情語氣。
- **canonical 契約共用**：引擎與任何維護對話都遵循同一套 Markdown 契約（`now.md` 七欄、三層模型）。

## 開發網頁引擎

- **TDD（Vitest）**。本機跑：`cd app && npm install && cp .env.example .env`（填端點/model）`&& npm run dev`（同時起後端 5173 與 Vite 5174，開 http://localhost:5174 遊玩）。`npm run build` 後 `npm start` 由後端服務 React build。
- **設定化後端**：LLM 端點/金鑰/模型一律走 `app/.env`（`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`MODEL`），部署者可指自架（vLLM/Ollama/LM Studio）；前端不提供、也不應提供修改後端打哪個端點的介面，避免「金鑰留後端」與「前端能改後端要打的 URL」這兩個前提互相矛盾。
- **結構化輸出為核心契約**：要求模型能穩定產出 `===STATE===` + JSON；解析失敗時引擎安全降級（保留敘事、暫停等玩家、發 warning），不維護弱模型純文字抽取路徑。
- 進度與計畫見 `docs/superpowers/plans/2026-06-19-web-app-implementation.md`（Phase 0–7）。

## 關鍵約定

- **狀態文件用 Markdown，不用 JSON**：故事和角色關係像 wiki 持續生長，結構化欄位會限制敘事彈性。維持人類可讀、分段清晰，方便增量編輯而非整篇重寫。
- **`index.md` 類文件是為了省 context**：角色一多就不能每次全讀，先讀索引，需要細節再讀對應檔案。`dungeons/<id>/wiki.md` 同理優先於 `runs/*.md` 全文。
- **`wiki.md`（提煉知識）與 `runs/*.md`（原始記錄）分離**：`runs/*.md` 是不可篡改的流水帳（靠 git 歷史天然防竄改），`wiki.md`/角色檔案才是下次真正會讀的「canonical truth」。結算把 run log **提煉**進 wiki，而不是整段複製。
- **raw log 用檔案 append，不用 commit message 當 log，不用 sqlite**：原始記錄逐回合 append 到 `runs/*.md`／`journal.md`，commit message 只寫摘要。
- **回合即時落地**：狀態變動在發生的同一回合就寫入 canonical 檔並自動 commit（不留延遲結帳點）。一致性靠「敘事前讀 index 鎖定事實」。
- **機率事件必須真隨機**：技能命中、暴擊、隨機事件等一律由引擎伺服器端（`engine/roll.ts`，crypto d100）預擲骰並寫進 log，模型只能依序取用回報的骰值敘事。禁止模型自行「演」機率結果或先編故事再湊數字。
- **死亡也要結算**：新手保護機制是靠結算按 `world/setting.md` 規則處理（扣分、清狀態等），而不是靠丟棄/不落地來迴避後果。
- **隱藏設定逐步揭露**：`gm-notes.md`（世界層）與 `dungeons/<id>/secrets.md`（副本層）由引擎首次生成時自主寫入，**不跟使用者討論或預覽**，只用來讓暗線一致；只有劇情真的揭露到的部分才進 `setting.md`/`wiki.md`/敘事。commit message 提到這類文件時只寫事實（「生成隱藏設定」），不寫具體內容，避免 git log 劇透。
- **單一主角、單一世界**：本倉庫只服務一條故事線；想玩自己的版本應該 fork 倉庫，而不是在這裡加第二個主角或第二個世界。
