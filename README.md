# 無限世界冒險（Infinity World Adventure）

能正確保存劇情的**「無限恐怖」類型互動小說**：單一主角、單一世界，由使用者與 LLM 對話推進劇情。所有世界狀態、角色檔案、副本記錄都以 Markdown 保存在倉庫裡，**git 歷史本身就是故事的版本記錄**。

> 「無限恐怖」設定：主角進入由「主神/系統」掌控的空間，反覆進出「副本」執行任務賺取積分，用積分兌換能力成長，直到通關或死亡。具體規則以 `world/setting.md` 為準。

## 兩種遊玩路徑

兩條路徑共用同一份 `world/` canonical 狀態，可交替使用。

| 路徑 | 說明 | 狀態 |
|---|---|---|
| **Claude Code CLI + skills** | 用 Claude Code（或其他 LLM CLI）對話，靠 `.claude/skills/` 推進劇情 | 現行主路徑 |
| **網頁引擎 `app/`** | Node.js + TS 服務，回合引擎 + 可設定 OpenAI 相容後端 + 自動推進 | 開發中（Phase 0–2） |

> 引擎完成後會封存現行遊玩類 skills；在那之前 CLI 路徑仍是可用的主路徑。

## 快速開始（網頁引擎）

需要 Node.js ≥ 20。

```bash
cd app
npm install
cp .env.example .env     # 編輯 .env：填你的 LLM 端點與 model
npm run dev              # 開 http://127.0.0.1:5173
```

`.env` 重點設定（可指向自架模型節省費用）：

```ini
OPENAI_BASE_URL=https://api.openai.com/v1   # 或 vLLM / Ollama / LM Studio 的 OpenAI 相容端點
OPENAI_API_KEY=sk-...                        # 自架且不需金鑰時填任意非空值
MODEL=gpt-4o
```

常用指令：

```bash
npm run dev        # 開發模式（watch）
npm test           # 跑 Vitest 測試
npm run typecheck  # 型別檢查
npm run build      # 產出 dist/
npm start          # 跑 dist/
```

## 目錄結構

```
world/        # 世界狀態（canonical truth）：setting / now / journal / characters / dungeons
archives/     # /init-world 重置前的整份世界快照（唯讀）
.claude/      # CLI 路徑：skills 與 settings
app/          # 網頁引擎（Node.js + TypeScript，開發中）
docs/         # 設計文件與實作計畫
CLAUDE.md     # 給 Claude Code 的協作規範（兩條路徑、回合收束協議、關鍵約定）
```

## 文件指引

- **`CLAUDE.md`**：協作規範與架構總覽（先讀這份）。
- **`docs/superpowers/specs/2026-06-19-web-app-architecture-design.md`**：網頁引擎設計文件。
- **`docs/superpowers/plans/2026-06-19-web-app-implementation.md`**：分階段實作計畫（8 個 Phase）。

## 想玩自己的版本？

本倉庫只服務一條故事線（單一主角、單一世界）。想玩自己的版本請 **fork** 倉庫，用 `/init-world` 重新生成世界設定，而不是在這裡加第二個主角。
