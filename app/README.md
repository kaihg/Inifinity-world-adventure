# 無限世界冒險 · 網頁引擎（app/）

把「無限恐怖」互動小說的回合驅動邏輯用 Node.js + TypeScript 實作成回合引擎：
可設定的 OpenAI 相容後端（含自架模型）、結構化輸出 + 伺服器端真隨機、
自動推進回合（無需手動「繼續」）、副本模式（不切 git branch）、每回合自動 commit `world/`。

引擎**只寫上層倉庫的 `world/`**（canonical 狀態），不碰 `CLAUDE.md` 或引擎程式碼。

## 需求

- Node.js ≥ 20
- 一個 OpenAI 相容的 LLM 端點（OpenAI、vLLM、Ollama 的 OpenAI 模式、LM Studio 等）。
  **需具備穩定的結構化輸出能力**（引擎以 `===STATE===` + JSON 控制區塊驅動狀態落地）。

## 快速開始

```bash
cd app
npm install
cp .env.example .env     # 編輯 .env：填你的端點與 model
npm run dev              # 同時起後端(5173) 與 Vite(5174)
# 開 http://localhost:5174 開始遊玩
```

### `.env` 重點

```ini
OPENAI_BASE_URL=https://api.openai.com/v1   # 或自架端點，如 http://localhost:11434/v1
OPENAI_API_KEY=sk-...                        # 自架且不需金鑰時填任意非空值
MODEL=gpt-4o                                  # 或你的自架模型名
PORT=5173                                     # 後端埠
# HOST=127.0.0.1                              # 對外服務時可設 0.0.0.0
# DEBUG=false                                 # true 時跳過自動 commit（試玩用）
AUTO_ADVANCE_MAX=4                            # 單次請求最多自動推進幾回合
```

> base URL 與 model 也可在網頁的「⚙ 設定」頁執行期修改，會寫回 `.env`（API key 不在頁面顯示）。

## 指令

```bash
npm run dev        # 開發：後端 + Vite(HMR)，改 web/src/*.tsx 即時更新
npm run build      # tsc 後端 + vite build 前端 → web-dist/
npm start          # 跑 dist/，由後端在 PORT 服務 React build
npm test           # Vitest
npm run typecheck  # tsc --noEmit
```

## 運作概念

- **狀態**：上層 `world/` 的 Markdown 是唯一真相；引擎每回合決定論載入 `now.md` + `setting.md` + `characters/index.md`，回合結束覆寫 `now.md`、append raw log、自動 commit。
- **回合**：模型先串流敘事，再輸出 `===STATE===` + JSON 控制區塊（狀態變動、骰子回報、`awaiting_user_input`、`mode_transition`、建議動作）。
- **副本**：是 `now.md` 驅動的「模式」，不是 git branch；raw → `dungeons/<id>/runs/*.md`，提煉 → `wiki.md`，暗線 → `secrets.md`。
- **真隨機**：機率判定由伺服器端 crypto d100 預擲、寫進 log，模型只能依序取用。

詳見上層 `CLAUDE.md` 與 `docs/superpowers/`。
