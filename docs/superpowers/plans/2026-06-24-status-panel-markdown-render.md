# 側邊面板狀態欄位 Markdown 渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `StatusPanel` 側邊面板的狀態欄位（屬性/技能/物品欄/Buff-Debuff/伏筆/下一步打算）正確渲染 markdown，而不是顯示 `- **力量**: 10` 這種原始符號。

**Architecture:** 純前端展示層改動。`app/web/src/App.tsx` 的共用 `Field` 元件改用 `react-markdown` 渲染 `value`，搭配 `app/web/src/styles.css` 新增覆寫規則收緊 markdown 產生的 `<p>`/`<ul>`/`<li>`/`<strong>` 預設間距。不改動後端、不改動 `NpcPanel`。

**Tech Stack:** React 19、Vite 5、react-markdown v9（新增依賴）。

## Global Constraints

- 不啟用 `rehype-raw`，維持 react-markdown 預設不渲染原始 HTML 的安全行為。
- 範圍僅限 `app/web/src/App.tsx` 的 `Field` 元件與 `app/web/src/styles.css` 的 `.value` 相關規則；不動 `NpcPanel`、不動後端 `app/src/engine/context.ts`。
- 不建置自動化前端元件測試（專案目前無此慣例），改用手動驗證收尾。

---

### Task 1: 安裝 react-markdown 並改造 Field 元件

**Files:**
- Modify: `app/web/package.json`（新增依賴，由 `npm install` 自動寫入）
- Modify: `app/web/src/App.tsx:283-290`（`Field` 元件）

**Interfaces:**
- Consumes: 無新介面，沿用既有 `Field({ label, value }: { label: string; value: string })` 簽名。
- Produces: `Field` 元件對外行為不變（仍接收 `label`/`value` 兩個字串 prop），僅內部渲染方式改變，供 `StatusPanel`（`App.tsx:309-342`）與其他呼叫處沿用。

- [ ] **Step 1: 安裝 react-markdown 依賴**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app/web && npm install react-markdown
```
Expected: `package.json` 的 `dependencies` 新增一行 `"react-markdown": "^9.x.x"`，`npm install` 無錯誤結束。

- [ ] **Step 2: 改造 Field 元件渲染邏輯**

把 `app/web/src/App.tsx` 第 1 行的 import 區塊加上：

```tsx
import ReactMarkdown from "react-markdown";
```

把 `app/web/src/App.tsx:283-290` 的 `Field` 元件改成：

```tsx
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

- [ ] **Step 3: 跑型別檢查確認沒有編譯錯誤**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npm run typecheck
```
Expected: 無 TypeScript 錯誤（`react-markdown` 自帶型別定義，`ReactMarkdown` 元件可直接接受 `children: string`）。

- [ ] **Step 4: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/web/package.json app/web/package-lock.json app/web/src/App.tsx
git commit -m "feat(web): StatusPanel 欄位改用 react-markdown 渲染"
```

---

### Task 2: 調整 `.value` 樣式以適配 markdown 產生的標籤

**Files:**
- Modify: `app/web/src/styles.css:497-502`（`.value` 規則）

**Interfaces:**
- Consumes: Task 1 產生的 DOM 結構——`.value` 容器內現在會出現 `<p>`/`<ul>`/`<ol>`/`<li>`/`<strong>` 等 react-markdown 渲染標籤，而非純文字。
- Produces: 無對外介面，純樣式調整。

- [ ] **Step 1: 修改 `.value` 規則並新增子元素覆寫**

把 `app/web/src/styles.css:497-502` 的：

```css
.value {
  white-space: pre-wrap;
  margin: 0.15rem 0 0;
  font-size: 0.88rem;
  color: var(--text);
}
```

改成：

```css
.value {
  margin: 0.15rem 0 0;
  font-size: 0.88rem;
  color: var(--text);
}

.value p {
  margin: 0 0 0.3rem;
}

.value p:last-child {
  margin-bottom: 0;
}

.value ul,
.value ol {
  margin: 0.2rem 0;
  padding-left: 1.1rem;
}

.value li {
  margin: 0.1rem 0;
}

.value strong {
  color: var(--text);
  font-weight: 600;
}
```

（移除 `white-space: pre-wrap`：原本靠這個屬性保留純文字的換行符，現在換行由 markdown 渲染出的 `<p>`/`<li>` 區塊負責，不再需要。）

- [ ] **Step 2: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/web/src/styles.css
git commit -m "style(web): 調整 .value 樣式以適配 markdown 渲染標籤"
```

---

### Task 3: 手動驗證

**Files:**
- 無新增/修改檔案，純驗證步驟。

**Interfaces:**
- Consumes: Task 1、Task 2 的完整改動。
- Produces: 無（驗證任務，確認功能正確即收尾本計畫）。

- [ ] **Step 1: 啟動開發伺服器**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npm run dev
```
Expected: 後端 5173、前端 Vite 5174 同時啟動，終端機出現 `Local: http://localhost:5174/`。

- [ ] **Step 2: 在瀏覽器檢查側邊面板渲染結果**

打開 `http://localhost:5174`，觀察右側 `StatusPanel`（桌面版常駐側邊欄；行動裝置版點右上角人形圖示開抽屜）。

確認項目：
1. 若 `world/characters/protagonist.md` 的「屬性」區塊內容是 `- **力量**: 10\n- **敏捷**: 8` 這類 markdown，畫面應呈現有縮排圓點的清單，「力量」「敏捷」字樣為粗體，**不**出現原始 `- **` 符號。
2. 「技能 / 異能」「物品欄」「Buff / Debuff」三個欄位同樣正確渲染清單與粗體（若該欄位內容本身就是純文字也應正常顯示，不出現空白或錯誤)。
3. 「未解懸念／伏筆」「主角下一步打算」兩欄位同樣正確渲染。
4. 單行欄位（當前篇章、此刻場景／地點、進行中的副本、最後更新）渲染結果與修改前一致（純文字，無異常空白或多餘 `<p>` 留白導致跑版）。
5. 開瀏覽器 DevTools Console，確認沒有新增的 React/console error。

Expected: 以上 5 項全部符合。若某欄位目前資料本身沒有 markdown 語法（例如 NPC 因新世界尚未產生內容），可暫時手動編輯 `world/characters/protagonist.md` 對應區塊加入測試用的 `- **測試屬性**: 1` 來驗證渲染效果，驗證完後 `git checkout` 還原該檔案（不要 commit 測試用的假資料）。

- [ ] **Step 3: 還原任何手動測試用的假資料（若有）**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure
git status world/
```
Expected: 若 Step 2 為了測試手動改過 `world/characters/protagonist.md`，這裡應顯示該檔案有未還原的變更；執行 `git checkout -- world/characters/protagonist.md` 還原。若沒有手動改過資料，此步驟略過。

- [ ] **Step 4: 停止開發伺服器**

在終端機按 `Ctrl+C` 停止 `npm run dev`。
