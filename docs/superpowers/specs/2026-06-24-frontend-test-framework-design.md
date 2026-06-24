# 前端測試框架準備 設計

## 問題

`app/` 目前的 Vitest 設定（`vitest.config.ts`）只覆蓋後端：`environment: "node"`、`include: ["src/**/*.test.ts"]`，完全不涵蓋 `web/` 底下的 React 元件。前端目前沒有任何元件測試慣例，[[2026-06-24-status-panel-markdown-render-design]] 這類純展示層 bug（`StatusPanel` 把 markdown 原始字串直接塞進純文字節點）只能靠手動驗證抓到，沒有自動化迴歸保護。

## 範圍

只先把框架搭起來、跑通，並補 1-2 個範例測試，不追求覆蓋率，不補齊既有元件（`StatusPanel`/`NpcPanel`/`WorldSetupWizard`/`DeathChoiceModal`/`EndWorldModal`）的完整測試，不導入 E2E（Playwright）。

## 設計

### 工具選擇

- 前端元件測試用 **React Testing Library**（`@testing-library/react` + `@testing-library/jest-dom` + `@testing-library/user-event`）。React 19 已完全棄用 Enzyme 相容性，RTL 是目前主流且唯一實務選項。
- 渲染環境用 `jsdom`（新增 devDependency）。
- 沿用既有 Vitest（v2.1.3），用 **workspace** 機制讓 `npm test` 一次跑完後端（node 環境）與前端（jsdom 環境）兩邊，不需要兩條獨立指令。

新增 devDependencies：`jsdom`、`@testing-library/react`、`@testing-library/jest-dom`、`@testing-library/user-event`。

### 檔案結構

```
app/
  vitest.config.ts          # 不動內容，保留現有 server-only 設定（node 環境、src/**/*.test.ts）
  vitest.workspace.ts        # 新增：定義 server + web 兩個 project
  vitest.setup.web.ts        # 新增：web project 的 setupFiles，載入 @testing-library/jest-dom 的 matcher
  web/src/App.test.tsx       # 新增：第一批範例測試
```

`vitest.workspace.ts` 內容：
- 第一個 project 直接引用既有 `"./vitest.config.ts"`（不改動其內容，保持後端測試行為不變）。
- 第二個 project（`web`）用 inline 設定：`environment: "jsdom"`、`include: ["web/src/**/*.test.tsx"]`、`setupFiles: ["./vitest.setup.web.ts"]`、`name: "web"`。

### 元件可測試性調整

`Field` 元件目前是 `app/web/src/App.tsx` 內未匯出的私有函式（無法被測試檔案 import）。順手把它改成具名匯出：`export function Field(...)`。這不是新增功能，只是讓既有元件具備可測試性，屬於「碰到順手修」範圍，不擴及其他私有元件（`StatusPanel`/`NpcPanel`/icon 元件等維持現狀，不在本次匯出/測試範圍）。

### 範例測試內容

`web/src/App.test.tsx` 聚焦剛修好的 markdown 渲染（[[2026-06-24-status-panel-markdown-render-design]]），直接為該次 bug fix 上鎖，避免回歸：

1. `Field` 傳入 `"- **力量**: 10\n- **敏捷**: 8"` 時，渲染結果應包含 `<li>` 清單項目與 `<strong>` 粗體文字節點，且不應出現原始 `- **` 字串。
2. `Field` 傳入空字串時，渲染結果顯示 `—`。

### `package.json` 變更

`test`/`test:watch` script 維持 `vitest run`/`vitest` 不變——Vitest 偵測到 `vitest.workspace.ts` 存在時會自動套用 workspace 設定，不需要改 script 內容。新增的 devDependencies 由 `npm install -D jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event` 寫入。

## 驗證

跑 `npm test`，確認：
1. 後端既有測試（`src/**/*.test.ts`）维持全數通過，數量不變（不因 workspace 切分而漏跑）。
2. 新增的 `web/src/App.test.tsx` 兩個測試案例通過。
3. Vitest 輸出能看到 `server`/`web` 兩個 project 名稱分別跑測試的結果。

## 後續（不在本次範圍）

- 為 `StatusPanel`/`NpcPanel`/`WorldSetupWizard`/`DeathChoiceModal`/`EndWorldModal` 等其他元件補測試。
- 訂定前端測試覆蓋率目標。
- 評估是否需要 E2E（Playwright）測試關鍵使用者流程。

這些留待框架穩定運作後，視實際需要另開新的 brainstorming 流程處理。
