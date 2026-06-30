# World Knowledge Ingest 重設計 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重設計 Layer 3 知識落地管線：廢除 secrets.md、扁平化 entity 檔案結構、改為 Karpathy-style ingest（journal delta → entity extraction → entity rewrite → wiki rewrite）、Layer 2 schema 瘦身讓主角狀態完全歸 Layer 3。

**Architecture:** 每回合 Layer 1 敘事 append 到 journal.md 後，Layer 3 從 byte-offset cursor 讀取新段落，LLM 抽出涉及的 entity 清單，平行 rewrite 各 entity 的單一 .md 檔，最後 rewrite 受影響分類的 wiki.md 索引。Layer 2 只保留 done event 必需的欄位；主角狀態更新完全歸 Layer 3，從 narrative 中直接讀取（Layer 1 已寫進數字）。

**Tech Stack:** TypeScript, Node.js, Vitest, Zod, 現有 `LlmClient` 介面（`streamChat`）

## Global Constraints

- 測試框架：Vitest（`cd app && npx vitest run <test-file>`）
- TypeScript 嚴格模式，`no console.log`（用 pino logger）
- 所有 world/ 讀寫用 `node:fs/promises`，路徑用 `path.join`
- LLM call 失敗一律 warn + 降級（不拋錯中斷回合）
- 不修改前端（`app/web/`）、不修改 recall 索引邏輯（接上即可）
- 繁體化兜底：寫入 world/ 前呼叫 `toTraditional()`
- `world/.ingest-cursor` 純文字一行數字（byte offset）

---

## File Map

**修改：**
- `app/src/engine/lore.ts` — 移除 `loreDir()` / `ensureSecrets()`；`loadLore()` 改讀單一 `.md` 檔；`listLoreIds()` 改列目錄下 `.md` 檔名（去副檔名）
- `app/src/engine/schema.ts` — 移除 `LoreSyncSchema` / `parseLoreSyncOutput()` / `LoreEntityRef` / `LoreEntityRefSchema`；從 `FastControlSchema` 移除 `protagonist_points_delta` / `protagonist_changed` / `announced_dungeon`
- `app/src/engine/turn/lore-rewrite.ts` — 移除 `generateEntitySecrets()` / `ENTITY_SECRETS_DESIGNER_ROLE` / `ensureSecrets` 呼叫；`rewriteLoreEntity()` 改讀扁平 `.md`；`callProtagonistRewrite()` 移除「積分區塊照抄」限制（Layer 1 敘事已包含積分數字）
- `app/src/engine/turn/lore-sync.ts` — 內部實作換成呼叫 `runIngest()`；保留 `scheduleLoreSync` / `trackLoreSync` 介面（呼叫端不變）
- `app/src/engine/turn/types.ts` — 從 `TurnPlan` 移除 `buildLoreSync` 欄位
- `app/src/engine/turn/index.ts` — 移除 `buildLoreSyncMessages` 注入、lore-sync validate 相關呼叫
- `app/src/engine/turn/prompts.ts` — 移除 `buildLoreSyncMessages()`
- `app/src/engine/turn/dungeon-transition.ts` — 進入副本時 append boundary marker 到 journal
- `app/src/engine/dungeon.ts` — 結算時從 journal 過濾生成 log.md（取代 real-time append）

**新建：**
- `app/src/engine/ingest-cursor.ts` — byte offset 讀寫
- `app/src/engine/ingest.ts` — Step 1~3 ingest pipeline
- `app/src/engine/lint.ts` — lint 檢查邏輯
- `app/src/server/routes/lint.ts` — POST /api/world/lint
- `world/asset-bible.md` — 生成約束規則（GM 填內容，工程只建骨架）

**刪除：**
- `app/src/engine/turn/lore-sync-validate.ts`
- `app/src/engine/turn/lore-sync-validate.test.ts`

---

## Task 1: lore.ts API 扁平化

**Files:**
- Modify: `app/src/engine/lore.ts`
- Modify: `app/src/engine/turn/lore-rewrite.ts`
- Modify: `app/src/engine/turn/lore-sync.ts` （暫時性，只修呼叫路徑，Task 8 再整個換掉）
- Test: `app/src/engine/turn/lore-rewrite.test.ts`

**Interfaces:**
- Produces: `loreFilePath(worldDir, category, id): string` — `world/<category>/<id>.md`
- Produces: `loadLoreFile(worldDir, category, id, logger?): Promise<string>` — 讀單一 .md，ENOENT 回 `""`
- Produces: `rewriteLoreFile(worldDir, category, id, content, title, logger?): Promise<void>` — 整檔覆寫（含補 H1）
- Produces: `listLoreIds(worldDir, category, logger?): Promise<string[]>` — 列 .md 檔名去副檔名

- [ ] **Step 1: 寫 lore.ts 扁平 API 的失敗測試**

在 `app/src/engine/turn/lore-rewrite.test.ts` 新增（先確認 import 路徑可以跑）：

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loreFilePath, loadLoreFile, rewriteLoreFile, listLoreIds } from "../../engine/lore.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "lore-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("lore flat API", () => {
  it("loreFilePath returns world/<category>/<id>.md", () => {
    expect(loreFilePath(tmpDir, "skills", "邏輯推理")).toBe(
      path.join(tmpDir, "skills", "邏輯推理.md")
    );
  });

  it("loadLoreFile returns empty string when file missing", async () => {
    const result = await loadLoreFile(tmpDir, "skills", "不存在");
    expect(result).toBe("");
  });

  it("loadLoreFile returns content when file exists", async () => {
    await mkdir(path.join(tmpDir, "skills"), { recursive: true });
    await writeFile(path.join(tmpDir, "skills", "邏輯推理.md"), "# 邏輯推理\n\n內容", "utf8");
    const result = await loadLoreFile(tmpDir, "skills", "邏輯推理");
    expect(result).toBe("# 邏輯推理\n\n內容");
  });

  it("rewriteLoreFile creates file with H1 when title missing", async () => {
    await rewriteLoreFile(tmpDir, "skills", "邏輯推理", "內容段落", "邏輯推理");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(path.join(tmpDir, "skills", "邏輯推理.md"), "utf8");
    expect(content).toContain("# 邏輯推理");
    expect(content).toContain("內容段落");
  });

  it("listLoreIds returns .md filenames without extension", async () => {
    await mkdir(path.join(tmpDir, "skills"), { recursive: true });
    await writeFile(path.join(tmpDir, "skills", "技能A.md"), "", "utf8");
    await writeFile(path.join(tmpDir, "skills", "技能B.md"), "", "utf8");
    const ids = await listLoreIds(tmpDir, "skills");
    expect(ids.sort()).toEqual(["技能A", "技能B"]);
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd app && npx vitest run src/engine/turn/lore-rewrite.test.ts 2>&1 | tail -20
```
預期：`loreFilePath is not a function` 或類似 import 錯誤。

- [ ] **Step 3: 重寫 lore.ts**

```typescript
// app/src/engine/lore.ts
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";

export type LoreCategory = "dungeons" | "items" | "skills" | "scenes";

/** 扁平路徑：world/<category>/<id>.md */
export function loreFilePath(worldDir: string, category: LoreCategory, id: string): string {
  return path.join(worldDir, category, `${id}.md`);
}

function logUnexpectedReadError(logger: Logger, file: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
  logger.warn({ err, file }, "讀取 lore 檔案失敗（非檔案不存在）");
}

/** 讀單一 entity .md；ENOENT 回 "" */
export async function loadLoreFile(
  worldDir: string,
  category: LoreCategory,
  id: string,
  logger: Logger = defaultLogger,
): Promise<string> {
  const file = loreFilePath(worldDir, category, id);
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    logUnexpectedReadError(logger, file, err);
    return "";
  }
}

/** 整檔覆寫 entity .md；自動補 H1（僅在開頭缺 `# ` 時） */
export async function rewriteLoreFile(
  worldDir: string,
  category: LoreCategory,
  id: string,
  content: string,
  title: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  logger.debug({ category, id }, "整檔重寫 entity .md");
  const file = loreFilePath(worldDir, category, id);
  await mkdir(path.dirname(file), { recursive: true });
  const body = content.trim();
  const finalContent = /^#\s/.test(body) ? `${body}\n` : `# ${title}\n\n${body}\n`;
  await writeFile(file, finalContent, "utf8");
}

/** 列某分類下所有 entity id（.md 檔名去副檔名）；目錄不存在回 [] */
export async function listLoreIds(
  worldDir: string,
  category: LoreCategory,
  logger: Logger = defaultLogger,
): Promise<string[]> {
  const dir = path.join(worldDir, category);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "wiki.md")
      .map((e) => e.name.slice(0, -3));
  } catch (err) {
    logUnexpectedReadError(logger, dir, err);
    return [];
  }
}
```

- [ ] **Step 4: 更新 lore-rewrite.ts — 移除 secrets 相關，改用扁平 API**

將 `rewriteLoreEntity()` 中的 `loadLore()` / `ensureSecrets()` / `generateEntitySecrets()` 呼叫換掉：

```typescript
// 在 rewriteLoreEntity() 中，item/scene/skill 分支改為：
const existing = await loadLoreFile(deps.worldDir, category, safeId, log);
let scaffoldContent: string | undefined;
if (!existing) {
  const repoRoot = path.dirname(deps.worldDir);
  try {
    scaffoldContent = await getTemplate(entity.category, deps.worldDir, repoRoot);
  } catch (err) {
    log.warn({ err, category: entity.category }, "getTemplate 失敗，略過骨架注入");
  }
}
const title = `${ENTITY_CATEGORY_TITLE[entity.category]}（${entity.name}）`;
const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, title, existing, entity.category, log, context, scaffoldContent);
if (!content) return null;
return { id: safeId, category: entity.category, title, content };
```

刪除 `generateEntitySecrets()`、`ENTITY_SECRETS_DESIGNER_ROLE`、`ensureSecrets` import。

- [ ] **Step 5: 更新 lore-sync.ts 中使用 `loreDir()` / `loadLore()` 的地方**

在 `runLoreSync()` 的落地段：

```typescript
// 原本：
await rewriteLoreWiki(deps.worldDir, category, r.id, r.content, r.title, log);
// 改為：
await rewriteLoreFile(deps.worldDir, category, r.id, r.content, r.title, log);
```

同時更新 recall reindex 的 path 計算（移除 `loreDir()` 呼叫，改用 `loreFilePath()`）：

```typescript
// 原本（lore-sync.ts line ~199）：
path.join(loreDir(deps.worldDir, r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category], r.id), "wiki.md"),
// 改為：
loreFilePath(deps.worldDir, r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category], r.id),
```

- [ ] **Step 6: 確認測試通過**

```bash
cd app && npx vitest run src/engine/turn/lore-rewrite.test.ts 2>&1 | tail -20
```
預期：全部 PASS。

- [ ] **Step 7: 確認 TypeScript 編譯乾淨**

```bash
cd app && npx tsc --noEmit 2>&1 | head -40
```
預期：0 errors。

- [ ] **Step 8: 刪除 lore-sync-validate.ts 與其測試**

```bash
rm app/src/engine/turn/lore-sync-validate.ts
rm app/src/engine/turn/lore-sync-validate.test.ts
```

更新 `lore-sync.ts` 中的 import（移除 `reconcileEntityCategories` / `sanitizeTouchedEntities`）。再跑 `npx tsc --noEmit`，確認 0 errors。

- [ ] **Step 9: Commit**

```bash
git add app/src/engine/lore.ts app/src/engine/turn/lore-rewrite.ts app/src/engine/turn/lore-sync.ts app/src/engine/turn/lore-rewrite.test.ts
git add -u app/src/engine/turn/lore-sync-validate.ts app/src/engine/turn/lore-sync-validate.test.ts
git commit -m "refactor: 扁平化 lore.ts API，移除 secrets.md 相關邏輯"
```

---

## Task 2: Layer 2 Schema 瘦身

**Files:**
- Modify: `app/src/engine/schema.ts`
- Modify: `app/src/engine/turn/lore-sync.ts`
- Modify: `app/src/engine/turn/turn-core.ts`
- Modify: `app/src/engine/turn/types.ts`
- Modify: `app/src/engine/turn/prompts.ts`
- Modify: `app/src/engine/turn/index.ts`

**Interfaces:**
- Consumes: Task 1 完成的 lore.ts 扁平 API
- Produces: `FastControlSchema` 不再含 `protagonist_points_delta` / `protagonist_changed` / `announced_dungeon`
- Produces: `LoreSyncSchema` / `parseLoreSyncOutput` / `LoreEntityRef` 從 schema.ts 消失

- [ ] **Step 1: 從 schema.ts 移除不需要的欄位**

在 `FastControlSchema` 中刪除：
```typescript
// 刪除這三行：
protagonist_points_delta: z.number().optional(),
protagonist_changed: z.boolean().default(false),
announced_dungeon: AnnouncedDungeonSchema.optional(),
```

刪除整個 `LoreStateChangesSchema` / `LoreSyncSchema` / `parseLoreSyncOutput` / `LoreEntityRefSchema` / `LoreEntityRef` / `AnnouncedDungeonSchema` / `AnnouncedDungeon`。

- [ ] **Step 2: 確認 TypeScript 找到所有受影響的地方**

```bash
cd app && npx tsc --noEmit 2>&1 | head -60
```
列出所有 error，逐一修。

- [ ] **Step 3: 更新 lore-sync.ts — 移除已廢棄欄位的讀取**

`runLoreSync()` 中刪除：
```typescript
// 刪除這整段（protagonist delta 已改由 Layer 3 ingest 處理）：
const pointsDelta = changes.protagonist_points_delta ?? 0;
const protagonistChanged = changes.protagonist_changed === true;
// ... applyPointsDelta / callProtagonistRewrite 區塊
```

刪除 `changes.announced_dungeon` 的處理（`registerAnnouncedDungeon` 呼叫）。

- [ ] **Step 4: 更新 callProtagonistRewrite — 移除積分照抄限制**

在 `lore-rewrite.ts` 的 `callProtagonistRewrite()` system prompt 中，找到：
```
"- **「當前積分」數值與其所在區塊一律照抄現有全文，絕不可改動**（積分由引擎另行計算，你動了就是錯）。",
```
改為：
```
"- 若敘事片段明確寫出積分增減結果，更新「當前積分」欄位；若未提及則保持不變。",
```

- [ ] **Step 5: 從 TurnPlan 移除 buildLoreSync**

`types.ts` 中刪除：
```typescript
/** Layer 3（reactive-lore-sync）訊息建構器：拿主腦完整敘事，回傳 lore-sync 對話 */
buildLoreSync: (narrative: string) => ChatMessage[];
```

- [ ] **Step 6: 從 prompts.ts 移除 buildLoreSyncMessages**

刪除 `buildLoreSyncMessages()` 函式及其 export。

- [ ] **Step 7: 更新 index.ts — 移除 buildLoreSync 注入**

找到組裝 `TurnPlan` 的地方（主空間和副本各一處），刪除 `buildLoreSync: buildLoreSyncMessages(...)` 那行。

- [ ] **Step 8: 確認編譯與測試**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
cd app && npx vitest run 2>&1 | tail -30
```
預期：0 TypeScript errors，測試全綠（或只有預期中的 lore-sync.test.ts 需要更新）。

- [ ] **Step 9: Commit**

```bash
git add app/src/engine/schema.ts app/src/engine/turn/lore-sync.ts app/src/engine/turn/turn-core.ts app/src/engine/turn/types.ts app/src/engine/turn/prompts.ts app/src/engine/turn/index.ts app/src/engine/turn/lore-rewrite.ts
git commit -m "refactor: Layer 2 schema 瘦身，移除 protagonist/lore 欄位"
```

---

## Task 3: 副本邊界標記

**Files:**
- Modify: `app/src/engine/turn/dungeon-transition.ts`
- Modify: `app/src/engine/dungeon.ts`
- Test: `app/src/engine/turn/dungeon-transition.test.ts` （新建）

**Interfaces:**
- Produces: `appendDungeonBoundary(worldDir, dungeonRunId, type)` — 寫入 journal boundary marker
- Produces: `extractDungeonLog(journalContent, dungeonRunId): string` — 從 journal 抽出副本段落

- [ ] **Step 1: 寫邊界標記的失敗測試**

建立 `app/src/engine/turn/dungeon-transition.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractDungeonLog } from "../../engine/dungeon.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "dungeon-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("extractDungeonLog", () => {
  it("extracts content between start and end markers", () => {
    const journal = [
      "主空間的冒險繼續中...",
      "<!-- dungeon-start: 命運樞紐-run-001 2026-06-29T10:00:00 -->",
      "副本第一回合敘事",
      "副本第二回合敘事",
      "<!-- dungeon-end: 命運樞紐-run-001 -->",
      "主空間又回來了",
    ].join("\n");
    const result = extractDungeonLog(journal, "命運樞紐-run-001");
    expect(result).toContain("副本第一回合敘事");
    expect(result).toContain("副本第二回合敘事");
    expect(result).not.toContain("主空間的冒險");
    expect(result).not.toContain("主空間又回來了");
  });

  it("returns empty string when run id not found", () => {
    const journal = "主空間內容\n主空間更多內容";
    expect(extractDungeonLog(journal, "不存在-run-001")).toBe("");
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd app && npx vitest run src/engine/turn/dungeon-transition.test.ts 2>&1 | tail -10
```
預期：`extractDungeonLog is not a function`。

- [ ] **Step 3: 實作 extractDungeonLog 在 dungeon.ts**

在 `app/src/engine/dungeon.ts` 加入：

```typescript
/**
 * 從 journal 全文抽出指定副本 run 的段落（不含 boundary markers 本身）。
 * runId 格式：`<dungeonId>-run-<NNN>`。
 */
export function extractDungeonLog(journalContent: string, runId: string): string {
  const startMarker = `<!-- dungeon-start: ${runId} `;
  const endMarker = `<!-- dungeon-end: ${runId} -->`;
  const startIdx = journalContent.indexOf(startMarker);
  if (startIdx === -1) return "";
  const afterStart = journalContent.indexOf("\n", startIdx);
  if (afterStart === -1) return "";
  const endIdx = journalContent.indexOf(endMarker, afterStart);
  if (endIdx === -1) return journalContent.slice(afterStart + 1).trim();
  return journalContent.slice(afterStart + 1, endIdx).trim();
}
```

- [ ] **Step 4: 確認測試通過**

```bash
cd app && npx vitest run src/engine/turn/dungeon-transition.test.ts 2>&1 | tail -10
```
預期：PASS。

- [ ] **Step 5: 在 dungeon-transition.ts 加入 journal boundary marker 寫入**

在 `dungeon-transition.ts` 加入，進入副本時呼叫：

```typescript
import { appendJournal } from "../journal.js";

/**
 * 進入副本時在 journal 寫入起始邊界標記，供結算時過濾 log 用。
 * runId 格式：`<dungeonId>-run-<timestamp>`
 */
export async function appendDungeonStartMarker(
  worldDir: string,
  runId: string,
  isoTimestamp: string,
): Promise<void> {
  await appendJournal(worldDir, `\n<!-- dungeon-start: ${runId} ${isoTimestamp} -->\n`);
}

/** 結算時在 journal 寫入結束邊界標記 */
export async function appendDungeonEndMarker(
  worldDir: string,
  runId: string,
): Promise<void> {
  await appendJournal(worldDir, `\n<!-- dungeon-end: ${runId} -->\n`);
}
```

- [ ] **Step 6: 接線 — 在副本進入/結算時呼叫 marker 函式**

在 `turn/index.ts` 中找到 `enter_dungeon` 的處理（`generateSecrets` 附近），加入：
```typescript
await appendDungeonStartMarker(deps.worldDir, dungeonRunId, nowISOSeconds());
```

在 `settle_dungeon` 處理附近，加入：
```typescript
await appendDungeonEndMarker(deps.worldDir, dungeonRunId);
// 從 journal 過濾 + 寫入 log.md：
const journalContent = await readBestEffort(path.join(deps.worldDir, "journal.md")) ?? "";
const logContent = extractDungeonLog(journalContent, dungeonRunId);
if (logContent) {
  const logPath = path.join(deps.worldDir, "dungeons", `${dungeonId}-log.md`);
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, `# 副本記錄：${dungeonId}\n\n${logContent}\n`, "utf8");
}
```

注意：`dungeonRunId` 需要在 `enter_dungeon` 時生成並保存（可用 `${dungeonId}-run-${nowISOSeconds().replace(/[:.]/g, "-")}`）。

- [ ] **Step 7: 確認編譯**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 8: Commit**

```bash
git add app/src/engine/turn/dungeon-transition.ts app/src/engine/dungeon.ts app/src/engine/turn/index.ts app/src/engine/turn/dungeon-transition.test.ts
git commit -m "feat: 副本 journal 邊界標記 + 結算生成 log.md"
```

---

## Task 4: Ingest Cursor

**Files:**
- Create: `app/src/engine/ingest-cursor.ts`
- Test: `app/src/engine/ingest-cursor.test.ts`

**Interfaces:**
- Produces: `readCursor(worldDir): Promise<number>` — 讀 `.ingest-cursor`，不存在回 0
- Produces: `writeCursor(worldDir, offset): Promise<void>` — 寫 `.ingest-cursor`
- Produces: `readJournalDelta(worldDir, fromOffset): Promise<string>` — 讀 journal.md 從 offset 到結尾

- [ ] **Step 1: 寫失敗測試**

建立 `app/src/engine/ingest-cursor.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCursor, writeCursor, readJournalDelta } from "./ingest-cursor.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "cursor-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("ingest cursor", () => {
  it("readCursor returns 0 when cursor file missing", async () => {
    expect(await readCursor(tmpDir)).toBe(0);
  });

  it("writeCursor + readCursor round-trips offset", async () => {
    await writeCursor(tmpDir, 42);
    expect(await readCursor(tmpDir)).toBe(42);
  });

  it("readJournalDelta returns content after offset", async () => {
    const journal = "AAAA\nBBBB\nCCCC";
    await writeFile(path.join(tmpDir, "journal.md"), journal, "utf8");
    // Buffer.byteLength("AAAA\n") === 5
    const delta = await readJournalDelta(tmpDir, 5);
    expect(delta).toBe("BBBB\nCCCC");
  });

  it("readJournalDelta returns empty when offset === file length", async () => {
    const journal = "DONE";
    await writeFile(path.join(tmpDir, "journal.md"), journal, "utf8");
    const delta = await readJournalDelta(tmpDir, Buffer.byteLength(journal, "utf8"));
    expect(delta).toBe("");
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd app && npx vitest run src/engine/ingest-cursor.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: 實作 ingest-cursor.ts**

建立 `app/src/engine/ingest-cursor.ts`：

```typescript
import { readFile, writeFile, open } from "node:fs/promises";
import path from "node:path";

const CURSOR_FILE = ".ingest-cursor";

/** 讀取 ingest cursor（journal.md byte offset）；檔案不存在回 0 */
export async function readCursor(worldDir: string): Promise<number> {
  try {
    const content = await readFile(path.join(worldDir, CURSOR_FILE), "utf8");
    const n = parseInt(content.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/** 寫入 ingest cursor */
export async function writeCursor(worldDir: string, offset: number): Promise<void> {
  await writeFile(path.join(worldDir, CURSOR_FILE), String(offset), "utf8");
}

/** 讀取 journal.md 從 byteOffset 到結尾（UTF-8 byte offset） */
export async function readJournalDelta(worldDir: string, fromOffset: number): Promise<string> {
  const journalPath = path.join(worldDir, "journal.md");
  try {
    const fh = await open(journalPath, "r");
    try {
      const stat = await fh.stat();
      const size = stat.size;
      if (fromOffset >= size) return "";
      const buf = Buffer.allocUnsafe(size - fromOffset);
      await fh.read(buf, 0, buf.length, fromOffset);
      return buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: 確認測試通過**

```bash
cd app && npx vitest run src/engine/ingest-cursor.test.ts 2>&1 | tail -10
```
預期：全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/ingest-cursor.ts app/src/engine/ingest-cursor.test.ts
git commit -m "feat: ingest cursor（journal.md byte offset）"
```

---

## Task 5: Entity Extraction（Step 1）

**Files:**
- Create: `app/src/engine/ingest.ts`
- Test: `app/src/engine/ingest.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface ExtractedEntity {
  id: string;           // entity slug（優先用已存在的 id）
  category: "skill" | "item" | "scene" | "dungeon" | "character";
  name: string;         // 顯示名稱
}
export interface ExtractionResult {
  protagonist_changed: boolean;
  entities: ExtractedEntity[];
}
export async function extractEntities(
  client: LlmClient,
  narrative: string,
  assetBible: string,
  existingIds: Record<string, string[]>,
  log: Logger,
): Promise<ExtractionResult>
```

- [ ] **Step 1: 寫失敗測試**

建立 `app/src/engine/ingest.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import type { LlmClient } from "./llm/client.js";
import { extractEntities } from "./ingest.js";
import { createSilentLogger } from "./logger.js";

function makeMockClient(response: string): LlmClient {
  return {
    streamChat: vi.fn(async function* () { yield response; }),
  } as unknown as LlmClient;
}

const log = createSilentLogger();

describe("extractEntities", () => {
  it("parses protagonist_changed and entities from LLM JSON", async () => {
    const json = JSON.stringify({
      protagonist_changed: true,
      entities: [
        { id: "邏輯推理", category: "skill", name: "邏輯推理（中級）" },
      ],
    });
    const client = makeMockClient(json);
    const result = await extractEntities(client, "敘事內容", "", {}, log);
    expect(result.protagonist_changed).toBe(true);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("邏輯推理");
  });

  it("returns empty result on parse failure", async () => {
    const client = makeMockClient("不是 JSON");
    const result = await extractEntities(client, "敘事內容", "", {}, log);
    expect(result.protagonist_changed).toBe(false);
    expect(result.entities).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd app && npx vitest run src/engine/ingest.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: 實作 extractEntities**

建立 `app/src/engine/ingest.ts`（只實作 Step 1 部分）：

```typescript
import { z } from "zod";
import path from "node:path";
import type { LlmClient } from "./llm/client.js";
import type { Logger } from "./logger.js";
import { TRADITIONAL_CHINESE_RULE } from "./turn/prompts.js";

const ExtractedEntitySchema = z.object({
  id: z.string(),
  category: z.enum(["skill", "item", "scene", "dungeon", "character"]),
  name: z.string(),
});

const ExtractionResultSchema = z.object({
  protagonist_changed: z.boolean().default(false),
  entities: z.array(ExtractedEntitySchema).default([]),
});

export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export async function extractEntities(
  client: LlmClient,
  narrative: string,
  assetBible: string,
  existingIds: Record<string, string[]>,
  log: Logger,
): Promise<ExtractionResult> {
  const existingList = Object.entries(existingIds)
    .map(([cat, ids]) => `${cat}: ${ids.join(", ") || "（無）"}`)
    .join("\n");

  const messages = [
    {
      role: "system" as const,
      content: [
        "你是本世界敘事引擎的知識庫索引器。從敘事片段中識別「有狀態變化的實體」。",
        "只輸出 JSON，格式如下：",
        '{"protagonist_changed": bool, "entities": [{"id": string, "category": "skill"|"item"|"scene"|"dungeon"|"character", "name": string}]}',
        "",
        "規則：",
        "- protagonist_changed：主角有屬性/技能/物品/積分/buff 變化時為 true",
        "- entities：本回合有資訊更新的 NPC、道具、場景、技能、副本",
        "- id 優先使用已存在的 id（見下方清單），沒有匹配才用顯示名稱當 id",
        "- 主角本身不列入 entities（用 protagonist_changed 表示）",
        "- 主空間的日常對話、無變化的背景描述不要列入",
        `${TRADITIONAL_CHINESE_RULE}`,
        "",
        "已存在的實體 id：",
        existingList || "（無）",
        assetBible ? `\n資產約束（asset-bible）：\n${assetBible}` : "",
      ].join("\n"),
    },
    { role: "user" as const, content: `敘事片段：\n${narrative}` },
  ];

  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no JSON found");
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return ExtractionResultSchema.parse(parsed);
  } catch (err) {
    log.warn({ err }, "entity extraction 失敗，略過本次 ingest");
    return { protagonist_changed: false, entities: [] };
  }
}
```

- [ ] **Step 4: 確認測試通過**

```bash
cd app && npx vitest run src/engine/ingest.test.ts 2>&1 | tail -10
```
預期：PASS。

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/ingest.ts app/src/engine/ingest.test.ts
git commit -m "feat: ingest Step 1 entity extraction"
```

---

## Task 6: Entity Rewrite（Step 2）與 Wiki Rewrite（Step 3）

**Files:**
- Modify: `app/src/engine/ingest.ts`
- Modify: `app/src/engine/ingest.test.ts`

**Interfaces:**
- Consumes: `callLoreRewrite()` / `callProtagonistRewrite()` from `lore-rewrite.ts`
- Consumes: `loadLoreFile()` / `rewriteLoreFile()` / `listLoreIds()` from `lore.ts`
- Produces: `runIngest(deps, narrative, settingText, log): Promise<void>` — 完整三步管線

- [ ] **Step 1: 補 Step 2 / Step 3 的失敗測試**

在 `ingest.test.ts` 補：

```typescript
import { readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { runIngest } from "./ingest.js";
import type { TurnDeps } from "./turn/types.js";

describe("runIngest", () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "ingest-test-")); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it("writes entity file when entity extracted", async () => {
    // extraction → 抽到技能「邏輯推理」
    const extractionJson = JSON.stringify({
      protagonist_changed: false,
      entities: [{ id: "邏輯推理", category: "skill", name: "邏輯推理" }],
    });
    // entity rewrite → 回傳技能描述
    const entityRewriteText = "# 邏輯推理\n\n## 初級\n基礎邏輯訓練。";
    // wiki rewrite
    const wikiRewriteText = "# 技能索引\n\n## 主動技能\n- [[邏輯推理]]";

    let callCount = 0;
    const client = {
      streamChat: vi.fn(async function* () {
        callCount++;
        if (callCount === 1) yield extractionJson;       // Step 1
        else if (callCount === 2) yield entityRewriteText; // Step 2 entity
        else yield wikiRewriteText;                        // Step 3 wiki
      }),
    } as unknown as LlmClient;

    // 寫入 journal.md（cursor 從 0 開始讀全部）
    await writeFile(path.join(tmpDir, "journal.md"), "本回合敘事：主角使用了邏輯推理技能。", "utf8");
    await mkdir(path.join(tmpDir, "skills"), { recursive: true });

    const deps = {
      client,
      loreClient: client,
      worldDir: tmpDir,
      commit: vi.fn(async () => true),
    } as unknown as TurnDeps;

    await runIngest(deps, "本回合敘事：主角使用了邏輯推理技能。", "", log);

    const entityFile = await readFile(path.join(tmpDir, "skills", "邏輯推理.md"), "utf8");
    expect(entityFile).toContain("邏輯推理");
    const wikiFile = await readFile(path.join(tmpDir, "skills", "wiki.md"), "utf8");
    expect(wikiFile).toContain("[[邏輯推理]]");
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd app && npx vitest run src/engine/ingest.test.ts 2>&1 | tail -15
```
預期：`runIngest is not a function`。

- [ ] **Step 3: 實作 runIngest（Step 2 + Step 3）**

在 `app/src/engine/ingest.ts` 補：

```typescript
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { readCursor, writeCursor, readJournalDelta } from "./ingest-cursor.js";
import { loadLoreFile, rewriteLoreFile, listLoreIds, type LoreCategory } from "./lore.js";
import { callLoreRewrite, callProtagonistRewrite, ENTITY_CATEGORY_TO_LORE, ENTITY_CATEGORY_TITLE, type LoreRewriteCategory } from "./turn/lore-rewrite.js";
import { getTemplate } from "./template-loader.js";
import { toTraditional } from "./text/traditionalize.js";
import type { TurnDeps } from "./turn/types.js";

const CATEGORY_TO_LORE: Record<string, LoreCategory> = {
  skill: "skills", item: "items", scene: "scenes", dungeon: "dungeons",
};

const WIKI_FORMAT_HINT: Record<LoreCategory, string> = {
  skills: "分「主動技能」「被動技能」兩大段，各技能一行 `- [[id]]：簡述（持有者：xxx）`",
  items: "分「消耗品」「持久道具」，各道具一行 `- [[id]]：品質、效果簡述`",
  scenes: "各場景一行 `- [[id]]：環境基調、已知危險`",
  dungeons: "各副本一行 `- [[id]]：難度基調、狀態（進行中/結算）`",
};

export async function runIngest(
  deps: TurnDeps,
  narrative: string,
  settingText: string,
  log: Logger,
): Promise<void> {
  const loreClient = deps.loreClient ?? deps.controlClient ?? deps.client;

  // 讀 asset-bible
  let assetBible = "";
  try { assetBible = await readFile(path.join(deps.worldDir, "asset-bible.md"), "utf8"); } catch { /* 不存在則略過 */ }

  // Step 1: entity extraction
  const existingIds: Record<string, string[]> = {};
  for (const cat of ["skills", "items", "scenes", "dungeons"] as LoreCategory[]) {
    existingIds[cat] = await listLoreIds(deps.worldDir, cat, log);
  }
  const extraction = await extractEntities(loreClient, narrative, assetBible, existingIds, log);
  if (!extraction.protagonist_changed && extraction.entities.length === 0) {
    log.debug("ingest: 本回合無實體異動，跳過");
    return;
  }

  // Step 2: parallel entity patch
  const touchedByCategory: Record<string, string[]> = {};
  const entityTasks = extraction.entities.map(async (entity) => {
    const loreCat = CATEGORY_TO_LORE[entity.category];
    if (!loreCat) { log.warn({ entity }, "ingest: 未知 category，略過"); return; }
    const safeId = toTraditional(entity.id.trim());
    const existing = await loadLoreFile(deps.worldDir, loreCat, safeId, log);
    let scaffold: string | undefined;
    if (!existing) {
      try { scaffold = await getTemplate(entity.category as "skill" | "item" | "scene", deps.worldDir, path.dirname(deps.worldDir)); } catch { /* optional */ }
    }
    const title = `${entity.category === "dungeon" ? "副本" : ENTITY_CATEGORY_TITLE[entity.category as keyof typeof ENTITY_CATEGORY_TITLE] ?? entity.category}（${entity.name}）`;
    const content = await callLoreRewrite(loreClient, settingText, narrative, title, existing, entity.category as LoreRewriteCategory, log, undefined, scaffold);
    if (!content) { log.warn({ id: safeId }, "ingest Step 2: entity rewrite 失敗，略過"); return; }
    await rewriteLoreFile(deps.worldDir, loreCat, safeId, content, entity.name, log);
    if (!touchedByCategory[loreCat]) touchedByCategory[loreCat] = [];
    touchedByCategory[loreCat].push(safeId);
  });

  // protagonist
  let protagonistTouched = false;
  const protagonistTask = extraction.protagonist_changed
    ? (async () => {
        const pPath = path.join(deps.worldDir, "characters", "protagonist.md");
        const existing = await readFile(pPath, "utf8").catch(() => "");
        if (!existing) { log.warn("ingest: protagonist.md 不存在，略過"); return; }
        const content = await callProtagonistRewrite(loreClient, settingText, narrative, existing, log);
        if (!content) { log.warn("ingest: protagonist rewrite 失敗"); return; }
        await writeFile(pPath, content, "utf8");
        protagonistTouched = true;
      })()
    : Promise.resolve();

  await Promise.all([...entityTasks, protagonistTask]);

  // Step 3: per affected category wiki rewrite
  const wikiTasks = Object.entries(touchedByCategory).map(async ([loreCat, touchedIds]) => {
    const cat = loreCat as LoreCategory;
    const wikiPath = path.join(deps.worldDir, cat, "wiki.md");
    const existingWiki = await readFile(wikiPath, "utf8").catch(() => "");
    // 讀本次被更新的 entity 內容
    const touchedContents = await Promise.all(
      touchedIds.map(async (id) => {
        const content = await readFile(path.join(deps.worldDir, cat, `${id}.md`), "utf8").catch(() => "");
        return `### ${id}\n${content}`;
      })
    );
    const prompt = [
      `你是本世界的分類索引維護者。`,
      `根據以下「更新的實體內容」，更新「${cat}」的分類索引 wiki.md。`,
      `索引格式建議：${WIKI_FORMAT_HINT[cat]}`,
      "規則：保留索引中未被更新的條目；只對本次更新的條目修改或新增對應行；輸出整份 wiki.md 完整內容。",
      existingWiki ? `\n現有 wiki.md：\n${existingWiki}` : "\n（目前無 wiki.md，全新建立）",
      `\n本次更新的實體：\n${touchedContents.join("\n\n")}`,
    ].join("\n");

    let wikiContent = "";
    try {
      for await (const delta of loreClient.streamChat([
        { role: "system", content: prompt },
        { role: "user", content: "請輸出完整新版 wiki.md 內容。" },
      ])) wikiContent += delta;
    } catch (err) { log.warn({ err, cat }, "ingest Step 3: wiki rewrite 失敗，略過"); return; }
    if (!wikiContent.trim()) return;
    await mkdir(path.join(deps.worldDir, cat), { recursive: true });
    await writeFile(wikiPath, toTraditional(wikiContent.trim()) + "\n", "utf8");
  });
  await Promise.all(wikiTasks);

  if (Object.keys(touchedByCategory).length > 0 || protagonistTouched) {
    await deps.commit("ingest: 更新實體知識（entity.md / wiki.md）");
  }
}
```

- [ ] **Step 4: 確認測試通過**

```bash
cd app && npx vitest run src/engine/ingest.test.ts 2>&1 | tail -15
```
預期：全部 PASS。

- [ ] **Step 5: 確認 TypeScript 乾淨**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/ingest.ts app/src/engine/ingest.test.ts app/src/engine/ingest-cursor.ts
git commit -m "feat: ingest Step 2+3 entity/wiki rewrite pipeline"
```

---

## Task 7: 接線 — 取代舊 lore-sync 管線

**Files:**
- Modify: `app/src/engine/turn/lore-sync.ts`
- Modify: `app/src/engine/turn/lore-sync.test.ts`

**Interfaces:**
- Consumes: `runIngest(deps, narrative, settingText, log)` from `ingest.ts`
- Produces: `scheduleLoreSync` / `trackLoreSync` 介面不變（呼叫端零改動）

- [ ] **Step 1: 重寫 runLoreSync 呼叫 runIngest**

將 `lore-sync.ts` 的 `runLoreSync()` 主體換成：

```typescript
import { runIngest } from "../ingest.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function runLoreSync(
  deps: TurnDeps,
  narrative: string,
  settingText: string,
  _plan: TurnPlan,  // plan 已不需要（不再用 buildLoreSync），保留簽名不破壞呼叫端
  log: Logger,
): Promise<void> {
  try {
    await runIngest(deps, narrative, settingText, log);
  } catch (err) {
    log.warn({ err }, "Layer 3 ingest 失敗，本回合 lore 文件可能未完整補上");
  }
}
```

`scheduleLoreSync` / `trackLoreSync` 函式保持不變（它們只是 wrap `runLoreSync`）。

- [ ] **Step 2: 更新 lore-sync.test.ts**

舊測試測的是現在已不存在的 schema-based 行為，改為測試新管線的基本 smoke test：

```typescript
import { describe, it, expect, vi } from "vitest";
import { scheduleLoreSync } from "./lore-sync.js";
import type { TurnDeps, TurnPlan } from "./types.js";
import { createSilentLogger } from "../../logger.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "lore-sync-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("scheduleLoreSync", () => {
  it("does not throw when ingest returns empty extraction", async () => {
    const emptyJson = JSON.stringify({ protagonist_changed: false, entities: [] });
    const client = { streamChat: vi.fn(async function* () { yield emptyJson; }) } as unknown as any;
    await writeFile(path.join(tmpDir, "journal.md"), "無實體的敘事", "utf8");
    const deps = {
      client, loreClient: client, worldDir: tmpDir,
      commit: vi.fn(async () => false),
    } as unknown as TurnDeps;
    const plan = {} as TurnPlan;
    await expect(scheduleLoreSync(deps, "無實體的敘事", "", plan, createSilentLogger())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: 確認測試通過**

```bash
cd app && npx vitest run src/engine/turn/lore-sync.test.ts 2>&1 | tail -15
```

- [ ] **Step 4: 跑全部測試確認無回歸**

```bash
cd app && npx vitest run 2>&1 | tail -20
```
預期：全部 PASS 或只有預期中的測試更新需求。

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/lore-sync.ts app/src/engine/turn/lore-sync.test.ts
git commit -m "feat: Layer 3 接線 runIngest，取代舊 schema-based lore-sync"
```

---

## Task 8: world/asset-bible.md 骨架

**Files:**
- Create: `world/asset-bible.md`

**Interfaces:** 無（靜態文件，GM 填內容）

- [ ] **Step 1: 建立 asset-bible.md**

```bash
cat > world/asset-bible.md << 'EOF'
# Asset Bible

> 生成約束規則。所有技能/副本/道具的 ingest 生成前，引擎必須先讀此文件。
> GM 依實際世界觀填寫具體數值；初版只建骨架，避免 LLM 過度發揮。

## 技能分級尺度

| 等級 | 效果量級 | 副作用範圍 | 可觸碰「系統層級」 |
|------|---------|-----------|------------------|
| C    | 個人感知/反應 | 個人身上 | 不可 |
| B    | 影響小團體/環境 | 周圍環境 | 不可 |
| A    | 大範圍戰場 | 生態/社會 | 可察覺系統異常 |
| S    | 世界規則層 | 跨維度 | 可觸碰系統底層 |

> **例（C 級）**：個人感知強化，副作用在精神/身體狀態，絕不可有「看見因果線」等 A 級效果。

## 副本難度尺度

| 難度 | 基調 | 涉及主線暗線 | 敵人跨副本關聯 |
|------|------|-------------|--------------|
| 新手 | 生存/日常 | 否 | 否 |
| 進階 | 陰謀/懸疑 | 局部 | 可能 |
| 精英 | 世界真相 | 是 | 是 |

## 道具功率範圍

| 品質 | 效果上限 | 可有隱藏設定 |
|------|---------|------------|
| 普通 | 日常輔助 | 否（水壺就是水壺） |
| 稀有 | 戰術優勢 | 可選 |
| 史詩+ | 影響戰局 | 是 |

## 隱藏設定揭露原則

- 揭露條件必須明確（「升至 B 級以上」「完成第三次副本」）
- 揭露前完全不在敘事中呈現，不暗示，不鋪墊
- 量級不可超過 entity 所在等級/品質的上限
EOF
```

- [ ] **Step 2: Commit**

```bash
git add world/asset-bible.md
git commit -m "feat: world/asset-bible.md 骨架（待 GM 填寫具體數值）"
```

---

## Task 9: Lint 工具

**Files:**
- Create: `app/src/engine/lint.ts`
- Create: `app/src/server/routes/lint.ts`
- Modify: `app/src/server/index.ts` （或路由注冊檔）
- Test: `app/src/engine/lint.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface LintIssue { severity: "error" | "warn"; file: string; message: string; }
export async function runLint(worldDir: string, log: Logger): Promise<LintIssue[]>
```

- [ ] **Step 1: 寫 lint 失敗測試**

建立 `app/src/engine/lint.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runLint } from "./lint.js";
import { createSilentLogger } from "./logger.js";

let tmpDir: string;
const log = createSilentLogger();
beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "lint-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("runLint", () => {
  it("returns no issues for empty world", async () => {
    await writeFile(path.join(tmpDir, "now.md"), "# 當前局勢\n", "utf8");
    await writeFile(path.join(tmpDir, "journal.md"), "", "utf8");
    const issues = await runLint(tmpDir, log);
    expect(issues).toHaveLength(0);
  });

  it("warns when skills/wiki.md missing but entity files exist", async () => {
    await mkdir(path.join(tmpDir, "skills"), { recursive: true });
    await writeFile(path.join(tmpDir, "skills", "邏輯推理.md"), "# 邏輯推理", "utf8");
    await writeFile(path.join(tmpDir, "now.md"), "", "utf8");
    await writeFile(path.join(tmpDir, "journal.md"), "", "utf8");
    const issues = await runLint(tmpDir, log);
    const wikiIssue = issues.find((i) => i.message.includes("wiki.md") && i.file.includes("skills"));
    expect(wikiIssue).toBeDefined();
  });
});
```

- [ ] **Step 2: 確認測試失敗**

```bash
cd app && npx vitest run src/engine/lint.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: 實作 lint.ts**

建立 `app/src/engine/lint.ts`：

```typescript
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./logger.js";

export interface LintIssue {
  severity: "error" | "warn";
  file: string;
  message: string;
}

const LORE_CATEGORIES = ["skills", "items", "scenes", "dungeons"] as const;

export async function runLint(worldDir: string, log: Logger): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  for (const cat of LORE_CATEGORIES) {
    const catDir = path.join(worldDir, cat);
    let entityFiles: string[] = [];
    try {
      const entries = await readdir(catDir, { withFileTypes: true });
      entityFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "wiki.md")
        .map((e) => e.name);
    } catch { continue; }

    if (entityFiles.length > 0) {
      const wikiPath = path.join(catDir, "wiki.md");
      try { await access(wikiPath); } catch {
        issues.push({ severity: "warn", file: wikiPath, message: `${cat}/wiki.md 不存在，但有 ${entityFiles.length} 個 entity 檔案` });
      }
    }
  }

  return issues;
}

export async function formatLintReport(issues: LintIssue[]): Promise<string> {
  if (issues.length === 0) return "# Lint 報告\n\n✅ 無問題\n";
  const lines = issues.map((i) => `- [${i.severity.toUpperCase()}] ${i.file}: ${i.message}`);
  return `# Lint 報告\n\n共 ${issues.length} 個問題：\n\n${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: 確認測試通過**

```bash
cd app && npx vitest run src/engine/lint.test.ts 2>&1 | tail -10
```

- [ ] **Step 5: 建立 lint route**

建立 `app/src/server/routes/lint.ts`：

```typescript
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { runLint, formatLintReport } from "../../engine/lint.js";

export function registerLintRoute(app: FastifyInstance, worldDir: string): void {
  app.post("/api/world/lint", async (_req, reply) => {
    const log = app.log;
    const issues = await runLint(worldDir, log);
    const report = await formatLintReport(issues);
    await writeFile(path.join(worldDir, "lint-report.md"), report, "utf8");
    reply.send({ ok: true, issueCount: issues.length, issues });
  });
}
```

在 `app/src/server/index.ts`（或路由注冊處）加入：

```typescript
import { registerLintRoute } from "./routes/lint.js";
// 在 registerRoutes 或 app.register 區塊加入：
registerLintRoute(app, worldDir);
```

- [ ] **Step 6: 確認編譯與測試**

```bash
cd app && npx tsc --noEmit 2>&1 | head -20
cd app && npx vitest run 2>&1 | tail -20
```

- [ ] **Step 7: Commit**

```bash
git add app/src/engine/lint.ts app/src/engine/lint.test.ts app/src/server/routes/lint.ts app/src/server/index.ts
git commit -m "feat: lint 工具 + POST /api/world/lint"
```

---

## Self-Review

### Spec coverage check

| Spec 需求 | 對應 Task |
|----------|----------|
| secrets.md 廢除，合併進主檔 | Task 1（lore.ts 移除 ensureSecrets） |
| entity 扁平化（目錄→單一 .md） | Task 1（loreFilePath） |
| journal 成為唯一敘事源 | Task 3（副本不再 real-time append log） |
| 副本邊界標記 | Task 3 |
| Layer 2 schema 瘦身 | Task 2 |
| 主角完全歸 Layer 3 | Task 6（runIngest 的 protagonist 分支） |
| Ingest cursor（byte offset） | Task 4 |
| Entity extraction Step 1 | Task 5 |
| Entity rewrite Step 2 | Task 6 |
| Category wiki rewrite Step 3 | Task 6 |
| 接線取代舊 lore-sync | Task 7 |
| asset-bible.md 骨架 | Task 8 |
| Lint 工具 | Task 9 |
| wiki.md 是分類索引（非 per-entity） | Task 6（WIKI_FORMAT_HINT） |
| template 只用於新 entity | Task 6（`if (!existing)` guard） |

### Placeholder scan
無 TBD / TODO / "implement later"。

### Type consistency check
- `runIngest` 在 Task 6 定義，Task 7 呼叫，簽名一致。
- `TurnPlan.buildLoreSync` 在 Task 2 移除，Task 7 的 `runLoreSync` 收 `_plan` 但不用它（簽名相容）。
- `LoreCategory` 在 lore.ts 定義，ingest.ts 透過 `CATEGORY_TO_LORE` 對應，型別一致。
