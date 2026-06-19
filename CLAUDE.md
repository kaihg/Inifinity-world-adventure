# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 項目定位

這個 repo 不是傳統軟體項目，而是一個**「無限恐怖」類型小說的文本保存站與對話中心**：單一主角、單一世界，由使用者與 Claude Code（或其他 LLM CLI）對話推進劇情，所有世界狀態、角色檔案、副本記錄都以 Markdown 文件保存在倉庫裡，git 歷史本身就是故事的版本記錄。

「無限恐怖」設定：主角進入由「主神/系統」掌控的空間，反覆進出「副本」執行任務賺取積分，用積分兌換能力成長，直到通關或死亡。具體規則由 `world/setting.md` 定義，**不要憑空套用某部小說的設定，一切以倉庫裡實際寫的規則為準**。

本倉庫有**兩條遊玩路徑**，共用同一份 `world/` canonical 狀態：

1. **CLI + skills（現行主路徑）**：用 Claude Code（或其他 LLM CLI）對話，靠 `.claude/skills/` 下的 skill + git 操作推進。所有「開發」工作都是讀寫 Markdown + 用 skill + git。
2. **網頁引擎 `app/`（開發中）**：Node.js + TypeScript 服務，把 skill 邏輯用程式碼重實作成「回合引擎」，支援可設定的 OpenAI 相容後端（吃自架模型）、自動推進回合、每回合自動 commit。詳見下方〈網頁引擎路徑〉與 `docs/superpowers/specs/2026-06-19-web-app-architecture-design.md`。**引擎完成後會封存現行遊玩類 skills**（計畫 Phase 7），在那之前 skill 路徑仍是可用的主路徑。

## 核心循環

1. **世界狀態**存在 `world/`，是當前 lifetime 的唯一真相來源（canonical truth）。
2. **劇情模式切換** = `start-story` skill。這是跟一般倉庫維護對話（改 CLAUDE.md、調 skill、討論架構）的分界線——只有 `start-story` 之後的對話才代入主神/系統語氣與主角視角。主空間（副本之間：兌換積分、休整、NPC 互動）直接在當前分支對話+commit，不需要開 PR。每個敘事回合結束都要跑「回合收束協議」（記錄→提煉→索引→覆寫 now.md→提交），主空間 raw 記到 `world/journal.md`、副本記到 `runs/<run-id>.md`，並覆寫 `world/now.md` 當前局勢；協議定義見 `start-story`／`enter-dungeon` skill。**resume（新 session 接劇情）讀 `world/now.md`，不讀 `journal.md`**；`now.md` 的「進行中的副本」欄決定停在主空間或交給 `enter-dungeon`。
3. **進入副本** = 開一個 git branch + PR（`enter-dungeon` skill）。整個副本期間的劇情對話，逐步以 commit 落到該 branch 的 run log 裡。進入副本通常是**半強制**的：使用者可以主動要求，LLM 也要在 `start-story` 對話中依設定判斷「系統強制開啟副本」的劇情節點主動觸發，不必每次等使用者下指令。
4. **副本結束**（通關 / 死亡 / 撤退）都要**合併回 main**（`settle-dungeon` skill）——死亡不等於丟棄 PR，新手保護等後果由結算規則處理，不是靠不合併來逃避。
5. **合併後**觸發 `.github/workflows/settle-on-merge.yml`，提醒/觸發把本次 run 的內容提煉進角色檔案與副本 wiki。
6. **`/init-world`** 是唯一的「重開」入口：封存當前 `world/` 到 `archives/<timestamp>/`，再與用戶對話生成全新世界設定。

## 目錄結構

```
world/
  setting.md              # 玩家可見：主神表面規則、世界基調、當前篇章、新手保護條款——敘事必須嚴格遵守
  gm-notes.md              # 劇透文件：主神真實動機、世界真相、暗線，僅供保持一致，不可提前揭露
  journal.md              # 主空間 raw 層：append-only、帶時間戳的原始時間線（與副本 runs/*.md 對稱）
  now.md                  # 主空間提煉頁：覆寫式「當前局勢」快照，resume 入口（對稱副本 wiki.md）；讀這份接劇情，不讀 journal.md
  characters/
    index.md               # 輕量角色索引（先讀這個，不要一次讀全部角色檔案）
    protagonist.md          # 主角：積分、屬性、技能、物品、buff/debuff
    <npc-id>.md             # 重要 NPC/隊友/敵人檔案，隨故事持續更新
  dungeons/
    <dungeon-id>/
      wiki.md               # 該副本已揭露的累積知識（地圖/機關/規則），多次進入間延續，進副本時優先讀這份
      secrets.md            # 劇透文件：該副本真正的機關原理/NPC真實動機，首次進入時生成一次
      runs/<run-id>.md       # 單次進入的原始對話 log，append-only，對應一個 PR/branch
archives/
  <timestamp>/world/...      # /init-world 重置前的整份世界快照，只讀
.claude/skills/
  init-world/                # 重置世界
  start-story/                # 切換成劇情模式，處理副本之間的主空間對話
  enter-dungeon/              # 開副本（建分支+PR，開始敘事），含半強制觸發判斷
  roll-random/                # 產生可驗證隨機數，機率判定專用
  settle-dungeon/              # 副本結束後的結算 + 合併
.github/workflows/
  settle-on-merge.yml          # PR 合併到 main 後提醒/觸發結算
app/                           # 網頁引擎（開發中，Node.js + TypeScript）
  src/
    config.ts                  # LLM 後端等設定（OPENAI_BASE_URL/MODEL…），可指自架
    llm/client.ts              # OpenAI 相容串流 client（介面化、可換端點）
    engine/                    # 回合引擎：context（載入）、turn（回合/自動推進/模式路由）、dungeon（副本，非 branch）、schema、roll、stream-split、journal、now
    git/commit.ts              # 每回合自動 commit world/
    server/                    # Fastify：/api/state、/api/turn(SSE)、/
  web/                         # 前端（Vite + React）：狀態/NPC 面板、串流劇情、建議動作、設定頁
  vite.config.ts               # 前端 build/dev（dev 跑 5174 proxy /api 到後端 5173）
  .env.example                 # 設定範本
```

## 網頁引擎路徑（`app/`，開發中）

把 `start-story`／`enter-dungeon`／回合收束協議／`roll-random`／`settle-dungeon` 的邏輯用程式碼重實作，解決三個痛點：手動「繼續」、resume 落差、LLM 後端綁死。

- **劇情 / 開發分離**：`app/` 是劇情遊玩面，**只寫 `world/`**（與副本 branch），永不碰 `CLAUDE.md`／`.claude/skills/`／引擎自身程式碼；改這些屬於開發，走一般 git/PR 流程。
- **canonical 不變**：引擎沿用同一套 Markdown 契約（`now.md` 七欄、三層模型、回合收束協議）；`world/` 檔案架構不動。
- **設定化後端**：LLM 端點/模型全走 `app/.env`（`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`MODEL`），部署者可指自架（vLLM/Ollama/LM Studio）。
- **開發方式**：TDD（Vitest）。本機跑 `cd app && npm install && cp .env.example .env && npm run dev`（同時起後端 5173 與 Vite 5174）；`npm run build` 後 `npm start` 由後端服務 React build。
- **目前進度**：Phase 0–6 已完成——骨架、狀態載入器 + resume 面板、LLM client + 單回合敘事 + 自動 commit、結構化輸出（`===STATE===` sentinel + JSON）+ 伺服器端真隨機骰、自動推進回合（`awaiting_user_input` 驅動，消滅手動「繼續」）、**副本模式（mode-aware 路由，`runs/*.md` raw + `wiki.md` 提煉 + 首次生成 `secrets.md`，enter/settle 由 `mode_transition` 驅動，不切 git branch）**。**完整 UI（Vite + React：主角狀態/屬性/技能/buff 面板、NPC 面板、串流劇情、建議動作按鈕、LLM 設定頁，`/api/config` 可執行期改端點/模型並寫回 .env）**。Phase 7（封存 skills + CLAUDE.md 全面改寫）待做。計畫見 `docs/superpowers/plans/2026-06-19-web-app-implementation.md`。

## 關鍵約定

- **狀態文件用 Markdown，不用 JSON**：因為故事和角色關係會越來越複雜，類似 wiki 持續生長，結構化字段會限制敘事彈性。讀寫狀態時維持人類可讀、分段清晰，方便 LLM 增量編輯而不是整篇重寫。
- **`index.md` 類文件是為了省 context**：角色一多就不能每次全讀，先讀索引，需要細節再讀對應檔案。`dungeons/<id>/wiki.md` 同理優先於 `runs/*.md` 全文。
- **`wiki.md`（提煉知識）與 `runs/*.md`（原始記錄）分離**：`runs/*.md` 是不可篡改的流水帳（靠 git 歷史天然防止事後改寫），`wiki.md`/角色檔案才是下次對話真正會讀的「canonical truth」。結算時必須把 run log 提煉進 wiki，而不是整段複製。
- **raw log 用檔案 append，不用 commit message 當 log，不用 sqlite**：原始記錄逐回合 append 到 `runs/*.md`／`journal.md`，commit message 只寫摘要。否決 sqlite（二進位殺掉 git 防竄改與 PR 合併、違背 markdown 哲學）與「commit message 當 log」（純敘事回合需空 commit 當載體、提煉要靠 git log 撈）。
- **回合收束 + Stop hook 兜底**：狀態變動在發生的同一回合就寫入 canonical 檔（不留延遲結帳點）；`.claude/settings.json` 的 Stop hook 會在 `world/` 有未提交改動時提醒先 commit。一致性靠「敘事前讀 index 鎖定事實」與「settle 時的 lint subagent」雙重把關。
- **機率事件必須真隨機**：技能命中率、暴擊、隨機事件等一律先用 `roll-random` skill（實際跑 `python3 -c "import random; ..."` 之類命令）取得數值，再依數值敘事。禁止 LLM 直接「演」出一個機率結果而不擲骰，也禁止先編故事再湊一個隨機數。
- **死亡也要合併 PR**：新手保護機制是靠 `settle-dungeon` 按 `world/setting.md` 規則做結算（扣分、清狀態等），而不是不合併 PR 來迴避後果。
- **劇情模式 vs 維護對話要分清**：沒有進入 `start-story` 的對話（例如改這份 CLAUDE.md、調整 skill）不要代入主神/系統角色語氣；副本進入可以由劇情內容半強制觸發，不是只能等使用者明確下指令。
- **隱藏設定逐步揭露**：`gm-notes.md`（世界層）與 `dungeons/<id>/secrets.md`（副本層）由 LLM 在 `init-world`/`enter-dungeon` 首次生成時自主寫入，**不跟使用者討論或預覽**，只用來讓敘事的暗線保持一致；只有劇情真正發展到揭露節點，才把對應內容寫進 `setting.md`/`wiki.md`/對話敘事。commit message 提到這類文件時只寫事實（「生成隱藏設定」），不寫具體內容，避免 git log 劇透。
- **單一主角、單一世界**：本倉庫只服務一條故事線；其他人想玩自己的版本應該 fork 倉庫，而不是在這裡加第二個主角或第二個世界。
- **GitHub Action 默認零成本**：`settle-on-merge.yml` 默認只留言提醒，由使用者手動在 Claude Code 裡跑 `settle-dungeon`。如果要讓 Action 自動呼叫 Claude API 完成結算（會產生費用），需要自己加 `ANTHROPIC_API_KEY` secret 並按 workflow 文件裡的註解打開 `auto-settle` job。
