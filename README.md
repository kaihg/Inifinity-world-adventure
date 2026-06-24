# 無限世界冒險（Infinity World Adventure）

能正確保存劇情的**「無限恐怖」類型互動小說**：單一主角、單一世界，透過網頁引擎與 LLM 對話推進劇情。所有世界狀態、角色檔案、副本記錄都以 Markdown 保存在倉庫裡，**git 歷史本身就是故事的版本記錄**。

> 「無限恐怖」設定：主角進入由「主神/系統」掌控的空間，反覆進出「副本」執行任務賺取積分，用積分兌換能力成長，直到通關或死亡。具體規則以 `world/setting.md` 為準。

## 快速開始

需要 Node.js ≥ 20。

```bash
cd app
npm install
cp .env.example .env     # 編輯 .env：填你的 LLM 端點與 model
npm run dev              # 開 http://127.0.0.1:5174
```

## 設定說明（`app/.env`）

所有設定都在 `app/.env`，引擎啟動時讀取，前端無法修改（金鑰不外洩）。

### 主敘事 LLM（必填）

```ini
OPENAI_BASE_URL=https://api.openai.com/v1   # 或 vLLM / Ollama / LM Studio 的 OpenAI 相容端點
OPENAI_API_KEY=sk-...                        # 自架且不需金鑰時填任意非空值
MODEL=gpt-4o                                 # 使用的模型名稱
```

主敘事 LLM 負責每回合的故事推進、世界狀態更新、副本結算：先串流純敘事（Layer 1），再各發一次獨立 call 抽取結構化狀態（Layer 2 fast-control：now/主角/骰值/轉場/建議動作；Layer 3 lore-sync：npc/item/location/skill/wiki，延後落地不卡玩家）。建議使用能穩定輸出 JSON 結構的模型。

### 角色意圖 LLM（選填）

```ini
CHARACTER_OPENAI_BASE_URL=http://localhost:11434/v1   # 可指向另一個自架端點
CHARACTER_MODEL=qwen2.5:3b                            # 輕量模型即可
```

每回合敘事前，引擎會對當前在場的每個 NPC 各發一次輕量 call，取得該角色本回合的立場、意圖與語氣，注入主敘事的 system prompt。這讓 NPC 依照自己的背景與動機行動，而不是被動配合主角。

**未設定時**：自動沿用主敘事 LLM，功能仍然運作，但消耗較多 token。**設定自架輕量模型時**：角色意圖 call 走輕量端點，主敘事走主模型，兼顧角色一致性與成本。

### 其他設定

```ini
PORT=5173                      # 後端 API 埠（前端 dev server 跑 5174）
AUTO_ADVANCE_MAX=4             # 單次 /api/turn 最多自動推進幾回合
GIT_AUTHOR_NAME=...            # 每回合自動 commit 的 git 作者名稱
GIT_AUTHOR_EMAIL=...           # 每回合自動 commit 的 git 作者信箱
# WORLD_DIR=../world           # world/ 目錄路徑（預設自動偵測）
# DEBUG_MODE=true              # 開啟 debug logging，並跳過自動 commit
```

## 常用指令

```bash
npm run dev        # 同時啟動後端（5173）與 Vite 前端（5174），開發用
npm test           # 跑 Vitest 測試
npm run typecheck  # 型別檢查
npm run build      # 產出 dist/
npm start          # 跑 dist/（正式部署）
```

## 目錄結構

```
world/        # 世界狀態（canonical truth）：setting / now / journal / characters / dungeons
archives/     # 重置前的整份世界快照（唯讀）
app/          # 網頁引擎（Node.js + TypeScript）
docs/         # 設計文件與實作計畫
CLAUDE.md     # 給 Claude Code 的開發協作規範（引擎架構、回合收束協議、關鍵約定）
```

## 文件指引

- **`CLAUDE.md`**：引擎架構與開發規範（先讀這份）。
- **`docs/superpowers/specs/2026-06-19-web-app-architecture-design.md`**：網頁引擎設計文件。
- **`docs/superpowers/specs/2026-06-19-scene-pre-pass-design.md`**：角色意圖 pre-pass 設計文件。

## 想玩自己的版本？

本倉庫只服務一條故事線（單一主角、單一世界）。想玩自己的版本請 **fork** 倉庫，重建 `world/` 內容，而不是在這裡加第二個主角。
