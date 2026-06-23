# PR #40 reindex 修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 PR #40（`feat/npm-reindex-command`，新增 `npm run reindex` 全量重建語意索引指令）code review 找出的問題：型別漏洞（`as any`）、失敗時不回報非零 exit code、路徑解析隱含依賴 cwd 且重複發明了專案已有的 `loadConfig()` 邏輯、缺乏測試。

**Architecture:** 不重新設計功能，只重構既有的 `app/src/recall/reindex-all.ts`：把「列出 worldDir 下所有 .md 檔案」抽成可單獨測試的 `listMarkdownFiles()` 函式；把「worldDir / recall indexDir 該解析到哪」交給專案既有的 `loadConfig()`（`app/src/config.ts`）而不是自己用 `path.resolve("../world")` 重新發明一套依賴 cwd 的邏輯；main() 失敗時用 `process.exitCode = 1` 確保 CI/腳本呼叫方能偵測失敗。

**Tech Stack:** TypeScript（Node ESM，`tsx` 執行）、Vitest（測試）、Node `node:fs/promises`（`mkdtemp`/`readdir`/`readFile`）。

## Global Constraints

- Node 版本下限改為 `>=20.12`（`Dirent.parentPath` 在此版本才保證存在，移除 `as any` 必須建立在這個前提上）。
- 不引入新的第三方依賴。
- 維持 `npm run reindex` 這個指令名稱與行為（掃描 `world/` 下所有 `.md`、逐一切塊寫入 recall index），只修正其實作細節。
- 修正後 `npm run typecheck`、`npm run test`、`npm run build` 都必須通過。
- 這些修正是直接推進 PR #40 的分支（`feat/npm-reindex-command`），不是開新分支。

---

### Task 1: 切換到 PR #40 分支並調整 Node 版本下限

**Files:**
- Modify: `app/package.json:7-8`（`engines.node`）

**Interfaces:**
- 無新介面，純設定變更。

- [ ] **Step 1: 取得並切換到 PR 分支**

```bash
git fetch origin feat/npm-reindex-command
git checkout -b feat/npm-reindex-command origin/feat/npm-reindex-command
```

預期：分支切換成功，工作區出現 `app/src/recall/reindex-all.ts`（PR #40 新增的檔案）。

- [ ] **Step 2: 確認目前 `engines.node` 內容**

Read `app/package.json`，確認第 7-8 行為：

```json
  "engines": {
    "node": ">=20"
  },
```

- [ ] **Step 3: 把 Node 版本下限改為 `>=20.12`**

把上面那段改成：

```json
  "engines": {
    "node": ">=20.12"
  },
```

理由：`fs.Dirent.parentPath` 是 Node 20.12 才保證存在的屬性（更早的 20.x 只有已棄用的 `.path`）。Task 3 要移除 `reindex-all.ts` 裡用來相容兩種屬性的 `as any`，必須先把這個版本下限鎖死，否則在 20.0–20.11 上會在執行期出錯而不是型別錯誤。

- [ ] **Step 4: Commit**

```bash
cd app
git add package.json
git commit -m "chore: require Node >=20.12 for Dirent.parentPath"
```

---

### Task 2: 抽出 `listMarkdownFiles()` 並補測試（TDD）

**Files:**
- Create: `app/src/recall/list-markdown-files.ts`
- Test: `app/src/recall/list-markdown-files.test.ts`

**Interfaces:**
- Produces: `listMarkdownFiles(worldDir: string): Promise<string[]>` — 遞迴列出 `worldDir` 下所有 `.md` 檔案，回傳相對於 `worldDir` 的相對路徑（用 `path.relative`，已排序，供 Task 3 的 `reindex-all.ts` 使用）。

- [ ] **Step 1: 寫失敗的測試**

Create `app/src/recall/list-markdown-files.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMarkdownFiles } from "./list-markdown-files.js";

describe("listMarkdownFiles", () => {
  let worldDir: string;

  beforeEach(async () => {
    worldDir = await mkdtemp(path.join(os.tmpdir(), "list-markdown-files-test-"));
  });

  afterEach(async () => {
    await rm(worldDir, { recursive: true, force: true });
  });

  it("遞迴找出所有 .md 檔案，回傳相對於 worldDir 的路徑並排序", async () => {
    await writeFile(path.join(worldDir, "setting.md"), "# setting");
    await mkdir(path.join(worldDir, "characters"));
    await writeFile(path.join(worldDir, "characters", "protagonist.md"), "# protagonist");
    await writeFile(path.join(worldDir, "characters", "index.md"), "# index");

    const files = await listMarkdownFiles(worldDir);

    expect(files).toEqual(["characters/index.md", "characters/protagonist.md", "setting.md"]);
  });

  it("忽略非 .md 檔案", async () => {
    await writeFile(path.join(worldDir, "setting.md"), "# setting");
    await writeFile(path.join(worldDir, "README.txt"), "not markdown");

    const files = await listMarkdownFiles(worldDir);

    expect(files).toEqual(["setting.md"]);
  });

  it("空目錄回傳空陣列", async () => {
    const files = await listMarkdownFiles(worldDir);
    expect(files).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd app
npx vitest run src/recall/list-markdown-files.test.ts
```

預期：FAIL，錯誤訊息類似 `Cannot find module './list-markdown-files.js'`。

- [ ] **Step 3: 寫最小實作**

Create `app/src/recall/list-markdown-files.ts`:

```ts
import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * 遞迴列出 worldDir 底下所有 .md 檔案，回傳相對於 worldDir 的相對路徑（已排序）。
 * 依賴 Node >=20.12 的 Dirent.parentPath（見 app/package.json engines）。
 */
export async function listMarkdownFiles(worldDir: string): Promise<string[]> {
  const entries = await readdir(worldDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.relative(worldDir, path.join(entry.parentPath, entry.name)))
    .sort();
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd app
npx vitest run src/recall/list-markdown-files.test.ts
```

預期：PASS，3 個測試全綠。

- [ ] **Step 5: Commit**

```bash
cd app
git add src/recall/list-markdown-files.ts src/recall/list-markdown-files.test.ts
git commit -m "feat(recall): extract listMarkdownFiles helper with tests"
```

---

### Task 3: 重寫 `reindex-all.ts`：改用 `loadConfig()`、移除 `as any`、修正失敗時的 exit code

**Files:**
- Modify: `app/src/recall/reindex-all.ts`（整檔重寫）

**Interfaces:**
- Consumes: `listMarkdownFiles(worldDir: string): Promise<string[]>`（Task 2 產出）、`loadConfig(): AppConfig`（`app/src/config.ts` 既有，回傳含 `worldDir: string` 與 `recall.indexDir: string`）、`createRecallIndex(indexDir: string): RecallIndex`（`app/src/recall/index.ts` 既有）。
- 無新對外介面（這是一支直接以 `tsx` 執行的腳本，沒有 export）。

- [ ] **Step 1: 讀現有檔案確認目前內容**

Read `app/src/recall/reindex-all.ts`，確認目前內容仍是 PR #40 diff 裡那 35 行（含 `path.resolve("../world")` 與 `(entry as any).path`）。

- [ ] **Step 2: 整檔改寫**

把 `app/src/recall/reindex-all.ts` 內容換成：

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config.js";
import { listMarkdownFiles } from "./list-markdown-files.js";
import { createRecallIndex } from "./index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const worldDir = config.worldDir;
  const indexDir = config.recall.indexDir;

  console.log("Initializing Recall Index in:", indexDir);
  const recall = createRecallIndex(indexDir);

  const files = await listMarkdownFiles(worldDir);
  console.log(`Found ${files.length} markdown files in world/ to index.`);

  for (const file of files) {
    console.log(`Indexing ${file}...`);
    const content = await readFile(path.join(worldDir, file), "utf8");
    await recall.upsertFile(file, content);
  }

  console.log("Successfully indexed all files under world/!");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
```

這個改寫解決三個 review 問題：
1. `worldDir`/`indexDir` 改用 `loadConfig()`（`app/src/config.ts` 既有邏輯，用 `import.meta.url` 回推絕對路徑，不依賴執行時的 cwd，也尊重 `WORLD_DIR`/`RECALL_INDEX_DIR` 環境變數覆寫），不再自己重新發明一套 `path.resolve("../world")`。
2. 移除 `(entry as any).path`：因為 Task 1 已把 `engines.node` 鎖到 `>=20.12`，`listMarkdownFiles()`（Task 2）可以放心只用 `entry.parentPath`。
3. `main().catch` 改成設定 `process.exitCode = 1`，失敗時腳本會以非零碼結束，不會被誤判成功。

- [ ] **Step 3: 型別檢查**

```bash
cd app
npm run typecheck
```

預期：無錯誤輸出。

- [ ] **Step 4: 跑整套測試**

```bash
cd app
npm run test
```

預期：全部既有測試（含 Task 2 新增的 `list-markdown-files.test.ts`）通過，無新增失敗。

- [ ] **Step 5: 手動跑一次 reindex 確認行為不變**

```bash
cd app
npm run reindex
```

預期：終端輸出 `Initializing Recall Index in: .../.recall-index`、`Found N markdown files in world/ to index.`、逐檔 `Indexing ...`，最後 `Successfully indexed all files under world/!`；exit code 為 0（用 `echo $?` 確認）。

- [ ] **Step 6: Commit**

```bash
cd app
git add src/recall/reindex-all.ts
git commit -m "fix(recall): reuse loadConfig for reindex paths, drop any cast, report failures via exit code"
```

---

### Task 4: 整合驗證並推送

**Files:**
- 無新檔案修改，純驗證 + push。

**Interfaces:**
- 無。

- [ ] **Step 1: 跑完整建置確認沒有連動破壞**

```bash
cd app
npm run build
```

預期：`tsc -p tsconfig.build.json && vite build` 成功完成，無錯誤。

- [ ] **Step 2: 確認分支上的 3 個 commit 都在**

```bash
git log --oneline origin/feat/npm-reindex-command..HEAD
```

預期：看到 Task 1、Task 2、Task 3 的三個 commit。

- [ ] **Step 3: Push 更新到 PR #40 的分支**

```bash
git push -u origin feat/npm-reindex-command
```

預期：push 成功，PR #40 自動帶入這幾個新 commit。
