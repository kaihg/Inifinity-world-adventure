# 前端測試框架準備 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 `npm test` 能用 Vitest workspace 同時跑後端（node 環境）與前端（jsdom 環境）測試，並用 `Field` 元件的 markdown 渲染當第一批範例測試，鎖住已修好的 bug。

**Architecture:** 新增 `vitest.workspace.ts` 拆成 `server`（沿用現有 `vitest.config.ts` 原樣）與 `web`（新 inline 設定，`environment: "jsdom"`）兩個 project。前端測試用 React Testing Library + jest-dom matcher。把 `app/web/src/App.tsx` 的私有 `Field` 函式改成具名匯出，供測試 import。

**Tech Stack:** Vitest 2.1.3（已安裝）、新增 jsdom、@testing-library/react、@testing-library/jest-dom、@testing-library/user-event。

## Global Constraints

- 只先搭框架 + 1-2 個範例測試，不追求覆蓋率，不補齊 `StatusPanel`/`NpcPanel`/`WorldSetupWizard`/`DeathChoiceModal`/`EndWorldModal` 的測試。
- 不導入 E2E（Playwright）。
- `vitest.config.ts` 內容不變動，只被 `vitest.workspace.ts` 引用。
- `Field` 是本次唯一改成具名匯出的私有元件，其他私有元件（`StatusPanel`/`NpcPanel`/icon 元件）維持現狀。
- `package.json` 的 `test`/`test:watch` script 內容不變（`vitest run`/`vitest`），Vitest 偵測到 `vitest.workspace.ts` 會自動套用。

---

### Task 1: 建立 Vitest workspace + jsdom 環境 + Field 範例測試

**Files:**
- Create: `app/vitest.workspace.ts`
- Create: `app/vitest.setup.web.ts`
- Create: `app/web/src/App.test.tsx`
- Modify: `app/web/src/App.tsx:284`（`Field` 函式改具名匯出）
- Modify: `app/package.json`（新增 devDependencies，由 `npm install -D` 自動寫入）

**Interfaces:**
- Consumes: 無（這是第一個任務，從現有 `app/vitest.config.ts`、`app/web/src/App.tsx` 出發）。
- Produces: `export function Field({ label, value }: { label: string; value: string })` from `app/web/src/App.tsx`，供 `app/web/src/App.test.tsx` 與未來其他前端測試檔案 import。`app/vitest.workspace.ts` 定義兩個 project 名稱 `server`／`web`，供後續任務（驗證輸出）依賴這兩個名稱。

- [ ] **Step 1: 安裝前端測試相關 devDependencies**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npm install -D jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
```
Expected: `package.json` 的 `devDependencies` 新增四個套件，`npm install` 無錯誤結束。

- [ ] **Step 2: 把 Field 改成具名匯出（尚未寫測試前先做，讓下一步的測試檔案有東西可以 import）**

把 `app/web/src/App.tsx:284` 的：

```tsx
function Field({ label, value }: { label: string; value: string }) {
```

改成：

```tsx
export function Field({ label, value }: { label: string; value: string }) {
```

函式本體（284-292 行其餘部分）不變。

- [ ] **Step 3: 寫第一批範例測試（此時 vitest.workspace.ts 還不存在，預期會跑失敗）**

建立 `app/web/src/App.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./App";

describe("Field", () => {
  it("renders markdown lists and bold text instead of raw syntax", () => {
    render(<Field label="屬性" value={"- **力量**: 10\n- **敏捷**: 8"} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("力量: 10");
    expect(items[0].querySelector("strong")).toHaveTextContent("力量");
    expect(items[1]).toHaveTextContent("敏捷: 8");
    expect(screen.queryByText(/-\s*\*\*/)).not.toBeInTheDocument();
  });

  it("shows em dash placeholder when value is empty", () => {
    render(<Field label="屬性" value="" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: 跑測試確認因缺少 jsdom 環境設定而失敗**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run web/src/App.test.tsx
```
Expected: FAIL —— 現有 `vitest.config.ts` 的 `include` 是 `["src/**/*.test.ts"]`，不匹配 `web/src/App.test.tsx`，所以 Vitest 會回報「No test files found」或類似訊息，測試完全沒被執行到。

- [ ] **Step 5: 建立 vitest.setup.web.ts**

建立 `app/vitest.setup.web.ts`：

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 6: 建立 vitest.workspace.ts**

建立 `app/vitest.workspace.ts`：

```ts
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "vitest.config.ts",
  {
    test: {
      name: "web",
      environment: "jsdom",
      include: ["web/src/**/*.test.tsx"],
      setupFiles: ["./vitest.setup.web.ts"],
    },
  },
]);
```

- [ ] **Step 7: 跑測試確認通過**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npm test
```
Expected: PASS —— 輸出同時看到 `server`／`web` 兩個 project 的測試結果，`web/src/App.test.tsx` 的 2 個測試案例通過，後端原本的測試檔案數與案例數不變（沒有因為拆 workspace 而漏跑）。

- [ ] **Step 8: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/package.json app/package-lock.json app/vitest.workspace.ts app/vitest.setup.web.ts app/web/src/App.tsx app/web/src/App.test.tsx
git commit -m "test(web): 建立 Vitest workspace + jsdom 環境，補 Field markdown 渲染範例測試"
```

---

### Task 2: 驗證後端測試數量未受影響

**Files:**
- 無新增/修改檔案，純驗證步驟。

**Interfaces:**
- Consumes: Task 1 產生的 `vitest.workspace.ts`（`server`／`web` 兩個 project）。
- Produces: 無（驗證任務，確認框架整合正確即收尾本計畫）。

- [ ] **Step 1: 跑完整測試套件並記錄總數**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npm test 2>&1 | tail -15
```
Expected: 輸出包含類似：

```
Test Files  37 passed (37)
     Tests  316 passed (316)
```

（原本後端 36 個測試檔案、314 個測試案例，加上 Task 1 新增的 `web/src/App.test.tsx` 1 個檔案、2 個測試案例，應為 37 個檔案、316 個測試案例。若數字不是「原數 + 1 個檔案 + 2 個案例」，代表 workspace 設定有遺漏既有測試檔案，需要回頭檢查 `vitest.workspace.ts` 是否正確引用了 `vitest.config.ts`。）

- [ ] **Step 2: 確認既有 typecheck 不受影響**

`app/tsconfig.json` 的 `include` 只有 `["src"]`，本來就不涵蓋 `web/`，所以這個指令不會檢查 `App.test.tsx`／`Field` 具名匯出的型別（這是專案既有的既存缺口，不在本次範圍內修補）。這裡只是確認本次改動沒有意外動到後端的型別檢查行為：

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npm run typecheck
```
Expected: 無 TypeScript 錯誤，且行為與 Task 1 之前完全一致（因為 `tsconfig.json` 沒被改動，`web/` 本來就不在它的檢查範圍）。
