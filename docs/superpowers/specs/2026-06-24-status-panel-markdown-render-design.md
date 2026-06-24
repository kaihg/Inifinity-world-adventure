# 側邊面板狀態欄位 Markdown 渲染設計

## 問題

`app/web/src/App.tsx` 的 `StatusPanel` 透過共用的 `Field` 元件，把以下 6 個欄位的原始字串直接塞進 `<div className="value">{value}</div>`：

- `protagonistDetail.attributes`（屬性）
- `protagonistDetail.skills`（技能 / 異能）
- `protagonistDetail.items`（物品欄）
- `protagonistDetail.buffs`（Buff / Debuff）
- `now.threads`（未解懸念／伏筆）
- `now.nextStep`（主角下一步打算）

後端 `app/src/engine/context.ts` 的 `extractSection`/`parseProtagonistDetail` 是整段擷取 `world/characters/protagonist.md`／`world/now.md` 對應 `## ` 區塊的原始 markdown 內容（保留換行與 `- **粗體**` 等語法），未做任何清洗。前端僅以純文字節點渲染，導致使用者直接看到 `- **力量**: 10` 這類原始符號。

`NpcPanel` 的 `status`/`role` 欄位來源不同：由 `app/src/engine/npc-status-summary.ts` 的 `summarizeNpcStatus()` 強制產生「15 字以內、不含 markdown」的單行摘要，存進 `index.md` 表格 cell，本質上不含 markdown 語法，故不在本次範圍內。

## 範圍

僅修正前端渲染層，不改動後端。目標欄位：`StatusPanel` 內走 `Field` 元件的 6 個欄位（連同 `now.chapter`/`now.scene`/`now.activeDungeon`/`now.lastUpdated` 等單行欄位，因為共用同一元件，且單行文字經 markdown 渲染後行為不變）。

明確排除：`NpcPanel`、後端資料格式、自動化前端測試框架建置（見「後續」）。

## 設計

### 元件改動

新增依賴 `react-markdown`（v9，純 ESM，相容 React 19 + Vite 5，專案 `package.json` 已是 `"type": "module"`）。

`app/web/src/App.tsx` 的 `Field` 元件改為：

```tsx
import ReactMarkdown from "react-markdown";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="value">
        {value ? <ReactMarkdown>{value}</ReactMarkdown> : "—"}
      </div>
    </div>
  );
}
```

不啟用 `rehype-raw`，維持 react-markdown 預設不渲染原始 HTML 的安全行為——即使內容來源是 git 倉庫內自己 commit 的 markdown 檔案而非不可信使用者輸入，仍沒理由開放 raw HTML 解析。

### 樣式

`app/web/src/styles.css` 的 `.value` 目前是 `white-space: pre-wrap`，渲染對象從純文字節點變成 react-markdown 產生的 `<p>`/`<ul>`/`<li>`/`<strong>` 等標籤後，需新增覆寫規則收緊瀏覽器預設間距，使清單在側邊欄窄欄位內保持緊湊：

```css
.value p { margin: 0 0 0.3rem; }
.value p:last-child { margin-bottom: 0; }
.value ul, .value ol { margin: 0.2rem 0; padding-left: 1.1rem; }
.value li { margin: 0.1rem 0; }
.value strong { color: var(--text); font-weight: 600; }
```

`white-space: pre-wrap` 規則可移除（markdown 渲染後的換行由 `<p>`/`<li>` 區塊負責，不再需要靠 CSS 保留原始換行符）。

## 驗證

純展示層改動，手動驗證：啟動 `npm run dev`，打開側邊面板，確認 `protagonist.md` 裡 `- **力量**: 10` 這類內容正確渲染成有縮排的清單與粗體文字，而非原始符號；確認單行欄位（章節/場景等）渲染結果與修改前一致。不額外建置元件測試（前端目前無既有元件測試慣例）。

## 後續（不在本次範圍）

前端自動化測試框架的建置（決定測什麼、用什麼工具、覆蓋率目標）是獨立的基礎建設決策，待本次修正完成並手動驗證後，另開新的 brainstorming 流程處理。
