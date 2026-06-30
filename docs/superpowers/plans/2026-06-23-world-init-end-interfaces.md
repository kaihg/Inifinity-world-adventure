# World Init / End / 主角換代 接口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在引擎（`app/src/`）加入三個原生接口——世界初始化 `/api/world/init`、世界封存 `/api/world/end`、主角永久死亡後換代 `/api/world/protagonist`——並讓前端在「世界尚未初始化」與「主角剛死亡」兩個狀態下引導玩家走完流程，取代過去純手動編輯 `world/` 的作法。

**Architecture:** 後端新增 4 個獨立小模組（`world-status.ts`/`archive.ts`/`recall/clear-index.ts`/`protagonist-seed.ts`），各自零依賴、純函式為主，方便單獨測試；再用 4 個新路由（含 1 個既有路由的前置檢查）把它們組起來。Schema 新增 `protagonist_permanent_death` 欄位讓 Layer 2 結構化輸出能標記「故事真正畫下終點」，`turn-core.ts` 偵測到此欄位時寫入 `world/.pending-death` sentinel 檔，`/api/turn` 與 `/api/world/end` 都會檢查這個檔案來決定要不要擋下請求。前端加一個開機判斷（`/api/world/status`）與一個死亡抉擇 modal，串接新路由。

**Tech Stack:** TypeScript、Fastify、Zod、Vitest（TDD）、React（前端，無既有測試基礎設施，本計畫不新增前端測試框架，沿用「手動以 dev server 驗證」的現狀）。

## Global Constraints

- 所有新檔案路徑以 `app/src/` 或 `app/web/src/` 為起點，與既有模組同層級慣例一致（例如 `app/src/engine/<name>.ts` + 同目錄 `<name>.test.ts`）。
- `config.recall.enabled` / `config.recall.indexDir`（**不是** `config.recallEnabled`，這是 spec 文件用詞與實際程式碼的落差，本計畫一律用程式碼裡的真實欄位名）。
- `world/.pending-death` 路徑固定是 `path.join(worldDir, ".pending-death")`，內容為 ISO 時間戳字串，純粹當 sentinel。
- 任何寫 `world/` 檔案的新程式碼都遵循既有慣例：用 `node:fs/promises`，UTF-8，覆寫式檔案用整檔 `writeFile`、append-only 檔案用 `appendFile`。
- 所有新 export 函式/型別都要有明確型別標註（TypeScript 專案慣例，禁止 `any`）。
- 每個 Task 完成後執行 `npm test`（在 `app/` 目錄下）確認全綠才進入下一個 Task。

---

## Task 1: `world-status.ts` — 判斷世界是否已初始化

**Files:**
- Create: `app/src/engine/world-status.ts`
- Test: `app/src/engine/world-status.test.ts`

**Interfaces:**
- Produces: `UNINITIALIZED_SETTING_PLACEHOLDER: string`、`UNINITIALIZED_GM_NOTES_PLACEHOLDER: string`、`isWorldInitialized(worldDir: string): Promise<boolean>`— Task 9（`/api/world/status`）、Task 10（`/api/world/init`）、Task 11（`/api/world/end`）都會 import 這三者。

- [ ] **Step 1: 寫失敗測試**

建立 `app/src/engine/world-status.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isWorldInitialized, UNINITIALIZED_SETTING_PLACEHOLDER } from "./world-status.js";

describe("isWorldInitialized", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-world-status-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("setting.md 不存在（從未初始化過）→ false", async () => {
    expect(await isWorldInitialized(world)).toBe(false);
  });

  it("setting.md 是佔位文字 → false", async () => {
    await writeFile(path.join(world, "setting.md"), UNINITIALIZED_SETTING_PLACEHOLDER, "utf8");
    expect(await isWorldInitialized(world)).toBe(false);
  });

  it("setting.md 是正常內容 → true", async () => {
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n冷酷機械系統。\n", "utf8");
    expect(await isWorldInitialized(world)).toBe(true);
  });

  it("佔位文字前後有多餘空白仍判定為未初始化（trim 比較）", async () => {
    await writeFile(path.join(world, "setting.md"), `\n\n${UNINITIALIZED_SETTING_PLACEHOLDER}\n\n`, "utf8");
    expect(await isWorldInitialized(world)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/world-status.test.ts`
Expected: FAIL，錯誤訊息為找不到模組 `./world-status.js`

- [ ] **Step 3: 寫最小實作**

建立 `app/src/engine/world-status.ts`：

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";

/** world/setting.md 尚未初始化時的固定佔位內容（機器可判斷的 marker） */
export const UNINITIALIZED_SETTING_PLACEHOLDER = `# 世界設定（World Setting）

> 尚未初始化。請透過世界初始化精靈建立新世界。
`;

/** world/gm-notes.md 尚未初始化時的固定佔位內容 */
export const UNINITIALIZED_GM_NOTES_PLACEHOLDER = `# 世界隱藏真相（GM Notes）

> 尚未生成。
`;

/**
 * 判斷世界是否已初始化：setting.md 不存在，或內容（trim 後）等於佔位文字，都視為未初始化。
 * 只比對 setting.md，不檢查其他檔案——setting.md 是這個判斷的唯一真相來源。
 */
export async function isWorldInitialized(worldDir: string): Promise<boolean> {
  let settingMd: string;
  try {
    settingMd = await readFile(path.join(worldDir, "setting.md"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
  return settingMd.trim() !== UNINITIALIZED_SETTING_PLACEHOLDER.trim();
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/world-status.test.ts`
Expected: PASS（4 個測試）

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/world-status.ts app/src/engine/world-status.test.ts
git commit -m "feat(engine): 新增 isWorldInitialized 判斷世界是否已初始化"
```

---

## Task 2: `archive.ts` — 封存路徑格式與複製邏輯

**Files:**
- Create: `app/src/engine/archive.ts`
- Test: `app/src/engine/archive.test.ts`

**Interfaces:**
- Produces: `archiveTimestamp(now?: Date): string`、`archiveWorld(repoRoot: string, worldDir: string): Promise<string>`、`archiveWorldFiles(repoRoot: string, worldDir: string, relativePaths: string[]): Promise<string>`（回傳值都是相對於 `repoRoot` 的封存目錄路徑，例如 `archives/2026-06-23_14-30-00`）——Task 10/11/12 的 `/api/world/end`、`/api/world/protagonist` 會用。

- [ ] **Step 1: 寫失敗測試**

建立 `app/src/engine/archive.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { archiveTimestamp, archiveWorld, archiveWorldFiles } from "./archive.js";

describe("archiveTimestamp", () => {
  it("格式為 YYYY-MM-DD_HH-mm-ss（UTC，可字串排序）", () => {
    const ts = archiveTimestamp(new Date("2026-06-23T14:30:05.123Z"));
    expect(ts).toBe("2026-06-23_14-30-05");
  });
});

describe("archiveWorld / archiveWorldFiles", () => {
  let repoRoot: string;
  let worldDir: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-archive-repo-"));
    worldDir = path.join(repoRoot, "world");
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    await writeFile(path.join(worldDir, "setting.md"), "# 設定\n", "utf8");
    await writeFile(path.join(worldDir, "now.md"), "- 當前篇章：x\n", "utf8");
    await writeFile(path.join(worldDir, "journal.md"), "# 日誌\n", "utf8");
    await writeFile(path.join(worldDir, "characters", "protagonist.md"), "- 姓名：沈奕\n", "utf8");
    await writeFile(path.join(worldDir, "characters", "index.md"), "| ID |\n", "utf8");
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("archiveWorld 把整個 worldDir 複製到 archives/<ts>/world/，回傳相對路徑", async () => {
    const fixedNow = new Date("2026-06-23T14:30:05.000Z");
    const rel = await archiveWorld(repoRoot, worldDir, fixedNow);
    expect(rel).toBe("archives/2026-06-23_14-30-05");
    const settingCopy = await readFile(
      path.join(repoRoot, rel, "world", "setting.md"),
      "utf8",
    );
    expect(settingCopy).toBe("# 設定\n");
    const protagonistCopy = await readFile(
      path.join(repoRoot, rel, "world", "characters", "protagonist.md"),
      "utf8",
    );
    expect(protagonistCopy).toBe("- 姓名：沈奕\n");
  });

  it("archiveWorldFiles 只複製指定的相對路徑清單，保留子目錄結構", async () => {
    const fixedNow = new Date("2026-06-23T15:00:00.000Z");
    const rel = await archiveWorldFiles(
      repoRoot,
      worldDir,
      ["characters/protagonist.md", "characters/index.md", "journal.md", "now.md"],
      fixedNow,
    );
    expect(rel).toBe("archives/2026-06-23_15-00-00");
    const protagonistCopy = await readFile(
      path.join(repoRoot, rel, "world", "characters", "protagonist.md"),
      "utf8",
    );
    expect(protagonistCopy).toBe("- 姓名：沈奕\n");
    // setting.md 不在清單內，不該被複製
    await expect(
      access(path.join(repoRoot, rel, "world", "setting.md")),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/archive.test.ts`
Expected: FAIL，找不到模組 `./archive.js`

- [ ] **Step 3: 寫最小實作**

建立 `app/src/engine/archive.ts`：

```typescript
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

/** UTC 日期時間格式，可排序、人類可讀：2026-06-23_14-30-00 */
export function archiveTimestamp(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-06-23T14:30:05.123Z
  const [date, time] = iso.split("T");
  return `${date}_${time.slice(0, 8).replace(/:/g, "-")}`;
}

/**
 * 把 worldDir 整個目錄複製到 archives/<archiveTimestamp()>/world/。
 * 回傳封存目錄相對於 repoRoot 的路徑（例如 "archives/2026-06-23_14-30-00"）。
 */
export async function archiveWorld(
  repoRoot: string,
  worldDir: string,
  now: Date = new Date(),
): Promise<string> {
  const relArchiveDir = path.join("archives", archiveTimestamp(now));
  const dest = path.join(repoRoot, relArchiveDir, "world");
  await mkdir(dest, { recursive: true });
  await cp(worldDir, dest, { recursive: true, force: true });
  return relArchiveDir;
}

/**
 * 只把指定的相對路徑清單複製到 archives/<archiveTimestamp()>/world/，保留原始子目錄結構。
 * 用於主角換代時只封存部分檔案（protagonist.md/index.md/journal.md/now.md），
 * 不像 archiveWorld 整個目錄複製。
 */
export async function archiveWorldFiles(
  repoRoot: string,
  worldDir: string,
  relativePaths: string[],
  now: Date = new Date(),
): Promise<string> {
  const relArchiveDir = path.join("archives", archiveTimestamp(now));
  for (const rel of relativePaths) {
    const dest = path.join(repoRoot, relArchiveDir, "world", rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(path.join(worldDir, rel), dest, { force: true });
  }
  return relArchiveDir;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/archive.test.ts`
Expected: PASS（3 個測試）

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/archive.ts app/src/engine/archive.test.ts
git commit -m "feat(engine): 新增世界封存的時間戳格式與複製工具"
```

---

## Task 3: `recall/clear-index.ts` — 清除語意索引

**Files:**
- Create: `app/src/recall/clear-index.ts`
- Test: `app/src/recall/clear-index.test.ts`

**Interfaces:**
- Consumes: `AppConfig["recall"]`（型別來自 `app/src/config.ts`，欄位 `{ enabled: boolean; indexDir: string; topK: number }`）。
- Produces: `clearRecallIndex(recallConfig: { enabled: boolean; indexDir: string }): Promise<void>`——Task 10/11/12 的三個世界級路由完成 commit 後都會呼叫。

- [ ] **Step 1: 寫失敗測試**

建立 `app/src/recall/clear-index.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearRecallIndex } from "./clear-index.js";

describe("clearRecallIndex", () => {
  let indexDir: string;
  beforeEach(async () => {
    indexDir = await mkdtemp(path.join(tmpdir(), "iwa-recall-index-"));
    await writeFile(path.join(indexDir, "dummy.json"), "{}", "utf8");
  });
  afterEach(async () => {
    await rm(indexDir, { recursive: true, force: true });
  });

  it("enabled=true 時刪除整個 indexDir", async () => {
    await clearRecallIndex({ enabled: true, indexDir });
    await expect(access(indexDir)).rejects.toThrow();
  });

  it("enabled=false 時 no-op，不動 indexDir", async () => {
    await clearRecallIndex({ enabled: false, indexDir });
    await expect(access(indexDir)).resolves.not.toThrow();
  });

  it("indexDir 不存在時也不丟錯（force 行為）", async () => {
    await rm(indexDir, { recursive: true, force: true });
    await expect(clearRecallIndex({ enabled: true, indexDir })).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/recall/clear-index.test.ts`
Expected: FAIL，找不到模組 `./clear-index.js`

- [ ] **Step 3: 寫最小實作**

建立 `app/src/recall/clear-index.ts`：

```typescript
import { rm } from "node:fs/promises";

/**
 * 若 recall 啟用，刪除整個 .recall-index/ 目錄（derived cache，下次需要時 lazy 重建）。
 * 用於 world/init、world/end、主角換代後，避免舊世界的向量殘留污染新世界的檢索結果。
 */
export async function clearRecallIndex(
  recallConfig: { enabled: boolean; indexDir: string },
): Promise<void> {
  if (!recallConfig.enabled) return;
  await rm(recallConfig.indexDir, { recursive: true, force: true });
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/recall/clear-index.test.ts`
Expected: PASS（3 個測試）

- [ ] **Step 5: Commit**

```bash
git add app/src/recall/clear-index.ts app/src/recall/clear-index.test.ts
git commit -m "feat(recall): 新增 clearRecallIndex，世界級重置操作後清除語意索引"
```

---

## Task 4: `protagonist-seed.ts` — 主角 seed 型別與 prompt 建構

**Files:**
- Create: `app/src/engine/protagonist-seed.ts`
- Test: `app/src/engine/protagonist-seed.test.ts`

**Interfaces:**
- Produces: `ProtagonistSeed`（`{ name?: string; origin?: string; freeform?: string; build?: ProtagonistBuild }`）、`ProtagonistBuild`（`{ hiddenScore?: number; talents?: string[]; attributeAllocations?: Record<string, number> }`）、`buildProtagonistPrompt(seed: ProtagonistSeed): string`——Task 10/12 的 init/protagonist 路由用。

- [ ] **Step 1: 寫失敗測試**

建立 `app/src/engine/protagonist-seed.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { buildProtagonistPrompt, type ProtagonistSeed } from "./protagonist-seed.js";

describe("buildProtagonistPrompt", () => {
  it("有 name/origin/freeform 時，三者都出現在 prompt", () => {
    const seed: ProtagonistSeed = { name: "沈奕", origin: "地下拳手", freeform: "重情義" };
    const prompt = buildProtagonistPrompt(seed);
    expect(prompt).toContain("沈奕");
    expect(prompt).toContain("地下拳手");
    expect(prompt).toContain("重情義");
  });

  it("全部留空時，prompt 含「由你自由發揮」提示，且不丟錯", () => {
    const prompt = buildProtagonistPrompt({});
    expect(prompt).toContain("自由發揮");
  });

  it("只有 name 時，其餘欄位走自由發揮提示", () => {
    const prompt = buildProtagonistPrompt({ name: "阿明" });
    expect(prompt).toContain("阿明");
    expect(prompt).toContain("自由發揮");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/protagonist-seed.test.ts`
Expected: FAIL，找不到模組 `./protagonist-seed.js`

- [ ] **Step 3: 寫最小實作**

建立 `app/src/engine/protagonist-seed.ts`：

```typescript
/**
 * 主角生成種子。所有欄位皆 optional——未填欄位交給 LLM 自由發揮（見 buildProtagonistPrompt）。
 * build 欄位是未來「天賦/屬性點數分配」設定頁的擴充位，現階段不會被任何呼叫端填值。
 */
export interface ProtagonistSeed {
  name?: string;
  origin?: string;
  freeform?: string;
  build?: ProtagonistBuild;
}

/** 預留型別：未來獨立的「隱藏分數 → 天賦/屬性選擇」設定頁產出，現在純粹卡位。 */
export interface ProtagonistBuild {
  hiddenScore?: number;
  talents?: string[];
  attributeAllocations?: Record<string, number>;
}

const UNSPECIFIED = "（使用者未指定，由你自由發揮一個符合世界基調的設定）";

/**
 * 把 seed 組成生成 protagonist.md 用的 user prompt 片段。
 * 未填欄位以「由你自由發揮」提示取代，讓 LLM 自行補齊，呼叫端不需做預設值補齊。
 * 現在只用 name/origin/freeform；未來支援 build 時只在這裡加分支，呼叫端不必改。
 */
export function buildProtagonistPrompt(seed: ProtagonistSeed): string {
  const name = seed.name?.trim() || UNSPECIFIED;
  const origin = seed.origin?.trim() || UNSPECIFIED;
  const freeform = seed.freeform?.trim() || UNSPECIFIED;
  return [
    "請依下列玩家設定，生成主角檔案 protagonist.md（繁體中文）：",
    `- 姓名：${name}`,
    `- 出身/進入此系統的原因：${origin}`,
    `- 其他自由描述：${freeform}`,
  ].join("\n");
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/protagonist-seed.test.ts`
Expected: PASS（3 個測試）

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/protagonist-seed.ts app/src/engine/protagonist-seed.test.ts
git commit -m "feat(engine): 新增 ProtagonistSeed 型別與 buildProtagonistPrompt"
```

---

## Task 5: Schema 新增 `protagonist_permanent_death` 欄位

**Files:**
- Modify: `app/src/engine/schema.ts:47-56`（`FastControlSchema`）
- Test: `app/src/engine/schema.test.ts`（在既有檔案末尾新增 describe 區塊）

**Interfaces:**
- Consumes: 既有 `FastControlSchema`、`parseFastControlOutput`。
- Produces: `FastControl` 型別新增 `protagonist_permanent_death: boolean` 欄位（有 default，解析端可省略）——Task 6（turn-core）會讀 `control.protagonist_permanent_death`。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/engine/schema.test.ts` 末尾新增：

```typescript
describe("protagonist_permanent_death 欄位", () => {
  it("省略時預設為 false", () => {
    const control = parseFastControlOutput(
      '{"awaiting_user_input":true,"commit_summary":"x"}',
    );
    expect(control.protagonist_permanent_death).toBe(false);
  });

  it("顯式 true 被保留", () => {
    const control = parseFastControlOutput(
      '{"awaiting_user_input":true,"commit_summary":"x","protagonist_permanent_death":true}',
    );
    expect(control.protagonist_permanent_death).toBe(true);
  });

  it("顯式 false 被保留", () => {
    const control = parseFastControlOutput(
      '{"awaiting_user_input":true,"commit_summary":"x","protagonist_permanent_death":false}',
    );
    expect(control.protagonist_permanent_death).toBe(false);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/schema.test.ts`
Expected: FAIL，第一個新測試 `protagonist_permanent_death` 為 `undefined` 不等於 `false`

- [ ] **Step 3: 寫最小實作**

修改 `app/src/engine/schema.ts`，在 `FastControlSchema`（第 47-56 行）的 `awaiting_user_input` 之後新增一行。改動後的物件：

```typescript
export const FastControlSchema = z.object({
  state_changes: FastStateChangesSchema,
  rolls: z.array(RollReportSchema).default([]),
  mode_transition: z.enum(["enter_dungeon", "settle_dungeon"]).nullable().default(null),
  transition_dungeon_id: z.string().nullable().optional(),
  transition_dungeon_goal: z.string().nullable().optional(),
  awaiting_user_input: z.boolean(),
  protagonist_permanent_death: z.boolean().default(false),
  suggested_actions: z.array(z.string()).default([]),
  commit_summary: z.string().min(1),
});
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/schema.test.ts`
Expected: PASS（既有測試 + 3 個新測試）

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/schema.ts app/src/engine/schema.test.ts
git commit -m "feat(schema): FastControl 新增 protagonist_permanent_death 欄位"
```

---

## Task 6: turn-core 處理主角永久死亡

**Files:**
- Modify: `app/src/engine/turn/turn-core.ts`（done event 組裝段，第 76-140 行附近）
- Modify: `app/src/engine/turn/types.ts:47-58`（`TurnEvent` 的 done 分支）
- Test: `app/src/engine/turn/index.test.ts`（新增 describe 區塊）

**Interfaces:**
- Consumes: `FastControl.protagonist_permanent_death`（Task 5）、既有 `serializeNow`/`parseNow`、`applyNowChanges`。
- Produces: `TurnEvent` 的 done 分支新增 `protagonistDied: boolean`；turn-core 在 `protagonist_permanent_death === true` 時寫 `world/.pending-death`、覆寫 now.md 的 nextStep、強制 `awaitingUserInput=true`、done 帶 `protagonistDied=true`。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/engine/turn/index.test.ts` 末尾新增（檔案已 import `runMainSpaceTurn`、`readFile`、`path`、`access` 改用 readFile catch）：

```typescript
describe("主角永久死亡（protagonist_permanent_death）", () => {
  it("control 標記永久死亡時：寫 .pending-death、覆寫 nextStep、強制 awaiting=true、done 帶 protagonistDied", async () => {
    const ctrl = JSON.stringify({
      state_changes: {},
      rolls: [],
      mode_transition: "settle_dungeon",
      awaiting_user_input: false, // 模型給 false，引擎必須覆寫成 true
      protagonist_permanent_death: true,
      suggested_actions: ["再來一次"],
      commit_summary: "主角戰死",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["沈奕倒下了，這次沒有豁免額度。"]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "拚死一搏",
    )) {
      events.push(ev);
    }

    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.protagonistDied).toBe(true);
    expect(done.awaitingUserInput).toBe(true); // 即使模型回 false 也被覆寫

    const pending = await readFile(path.join(world, ".pending-death"), "utf8");
    expect(pending.trim().length).toBeGreaterThan(0);

    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("等待抉擇：保留世界換主角 / 結束世界");
  });

  it("一般回合（無永久死亡）：不寫 .pending-death、done.protagonistDied 為 false", async () => {
    const ctrl = JSON.stringify({
      state_changes: {},
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: [],
      commit_summary: "平安無事",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["風平浪靜。"]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "休息",
    )) {
      events.push(ev);
    }
    const done: any = events.at(-1);
    expect(done.protagonistDied).toBe(false);
    await expect(readFile(path.join(world, ".pending-death"), "utf8")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts`
Expected: FAIL，`done.protagonistDied` 為 `undefined`

- [ ] **Step 3: 寫實作 — types.ts**

修改 `app/src/engine/turn/types.ts` 的 `TurnEvent` done 分支（第 47-58 行），新增 `protagonistDied`：

```typescript
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: FastControl["mode_transition"];
      transitionDungeonId?: string;
      transitionDungeonGoal?: string;
      /** 主角永久死亡（新手保護耗盡）；true 時前端顯示死亡抉擇 modal */
      protagonistDied: boolean;
      /** 本回合 Layer 2 落地後的當前狀態快照，供前端面板即時更新；loadState 失敗時省略 */
      state?: GameState;
    };
```

- [ ] **Step 4: 寫實作 — turn-core.ts**

在 `app/src/engine/turn/turn-core.ts` 頂部 import 區，把 `writeFile` 已經有了；新增 `randomUUID` 不需要（用時間戳）。在組 `done` event 之前（第 130 行 `yield { type: "done"` 之前）插入永久死亡處理，並修改 done event。

先在現有 import（第 1 行）確認 `writeFile` 已 import（是）。在第 120 行 `let stateSnapshot` 之前插入：

```typescript
  // 主角永久死亡：寫 sentinel、覆寫 now 下一步欄、強制暫停（不依賴模型自己回報 awaiting）
  const protagonistDied = control?.protagonist_permanent_death === true;
  if (protagonistDied) {
    await writeFile(path.join(deps.worldDir, ".pending-death"), new Date().toISOString(), "utf8");
    const nowPath2 = path.join(deps.worldDir, "now.md");
    const nowMd2 = await readFile(nowPath2, "utf8");
    const now2 = applyNowChanges(
      // parseNow 從 context.js；turn-core 已 import loadState 但未 import parseNow，需補 import
      parseNow(nowMd2),
      { nextStep: "等待抉擇：保留世界換主角 / 結束世界" },
      { date: today, summary },
    );
    await writeFile(nowPath2, serializeNow(now2), "utf8");
  }
```

把 done event（第 130-140 行）的 `awaitingUserInput` 與新增 `protagonistDied` 改為：

```typescript
  yield {
    type: "done",
    narrative,
    committed,
    awaitingUserInput: protagonistDied ? true : (control?.awaiting_user_input ?? true),
    suggestedActions,
    modeTransition: control?.mode_transition ?? null,
    transitionDungeonId: control?.transition_dungeon_id || undefined,
    transitionDungeonGoal: control?.transition_dungeon_goal || undefined,
    protagonistDied,
    state: stateSnapshot,
  };
```

在 turn-core.ts 第 4-9 行的 `from "../context.js"` import 補上 `parseNow`：

```typescript
import {
  applyPointsDelta,
  applyProtagonistUpdates,
  loadState,
  parseNow,
  type GameState,
} from "../context.js";
```

> 注意：`parseNow` 已在 context.ts export（見第 66 行）。`serializeNow`/`applyNowChanges` 已從 `../now.js` import（第 10 行）。

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts`
Expected: PASS（既有測試 + 2 個新測試）

- [ ] **Step 6: 全量測試 + commit**

Run: `cd app && npm test`
Expected: 全綠（注意：既有測試若有處 done event 斷言可能需要新欄位，但 protagonistDied 是新增非破壞，既有測試不讀它，應不受影響）

```bash
git add app/src/engine/turn/turn-core.ts app/src/engine/turn/types.ts app/src/engine/turn/index.test.ts
git commit -m "feat(engine): turn-core 偵測主角永久死亡，寫 .pending-death 並強制暫停"
```

---

## Task 7: `.gitignore` 排除 `world/.pending-death`

**Files:**
- Modify: `.gitignore`（repo 根目錄，第 8 行後新增）

**Interfaces:** 無程式碼介面；純設定變更。確保 `commitWorld` 的 `git.add(["world"])` 不會把 sentinel 檔 commit 進歷史。

- [ ] **Step 1: 修改 .gitignore**

在 `.gitignore` 末尾（`.codegraph/` 之後）新增：

```
world/.pending-death
```

- [ ] **Step 2: 驗證忽略生效**

Run: `printf 'test' > world/.pending-death && git check-ignore world/.pending-death && rm world/.pending-death`
Expected: 輸出 `world/.pending-death`（代表被忽略），且 rm 後乾淨

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore 排除 world/.pending-death sentinel 檔"
```

---

## Task 8: 前端 `api.ts` 型別補齊與新 API client 函式

**Files:**
- Modify: `app/web/src/api.ts`（`TurnEvent` done 分支、新增 4 個函式與 `WorldInitRequest`/`ProtagonistSeed` 型別）

**Interfaces:**
- Produces（給 Task 13 的 App.tsx 用）：`ProtagonistSeed`、`WorldInitRequest`、`fetchWorldStatus()`、`initWorld(body)`、`endWorld(confirmText)`、`resolveProtagonistDeath(body)`；`TurnEvent` done 分支新增 `protagonistDied`、`transitionDungeonId`、`transitionDungeonGoal`。

> 本專案前端無測試框架；本 Task 以 `npx tsc --noEmit`（型別檢查）作為驗證手段，不寫單元測試。

- [ ] **Step 1: 修改 TurnEvent done 分支**

把 `app/web/src/api.ts` 第 65-73 行的 done 分支改為（補上後端已有的 `transitionDungeonId`/`transitionDungeonGoal`、本次新增 `protagonistDied`）：

```typescript
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: string | null;
      transitionDungeonId?: string;
      transitionDungeonGoal?: string;
      protagonistDied: boolean;
      state?: GameState;
    };
```

- [ ] **Step 2: 新增型別與 API 函式**

在 `app/web/src/api.ts` 末尾新增：

```typescript
export interface ProtagonistSeed {
  name?: string;
  origin?: string;
  freeform?: string;
}

export interface WorldInitRequest {
  preferences?: {
    tone?: string;
    horrorIntensity?: string;
    godPersona?: string;
    protectionRule?: string;
  };
  protagonistSeed?: ProtagonistSeed;
}

export async function fetchWorldStatus(): Promise<{ initialized: boolean }> {
  const res = await fetch("/api/world/status");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function initWorld(body: WorldInitRequest): Promise<GameState> {
  const res = await fetch("/api/world/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function endWorld(confirmText: string): Promise<{ archivedTo: string }> {
  const res = await fetch("/api/world/end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmText }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

export async function resolveProtagonistDeath(
  body:
    | { choice: "keep-world"; protagonistSeed: ProtagonistSeed }
    | { choice: "end-world" },
): Promise<GameState | { archivedTo: string }> {
  const res = await fetch("/api/world/protagonist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
```

- [ ] **Step 3: 型別檢查**

Run: `cd app && npx tsc -p tsconfig.json --noEmit`
Expected: 無錯誤（注意：App.tsx 尚未用 protagonistDied，但 done 分支新欄位是必填——既有 App.tsx 不「建構」done event 只「讀取」，故不會因新增必填欄位報錯）

- [ ] **Step 4: Commit**

```bash
git add app/web/src/api.ts
git commit -m "feat(web): api.ts 補 TurnEvent 型別漂移、新增 world init/end/protagonist client"
```

---

## Task 9: `/api/world/status` 路由

**Files:**
- Modify: `app/src/server/app.ts`（在 `/api/state` 路由附近新增 GET 路由；import `isWorldInitialized`）
- Test: `app/src/server/app.test.ts`（新增 describe 區塊）

**Interfaces:**
- Consumes: `isWorldInitialized`（Task 1）、`config.worldDir`。
- Produces: `GET /api/world/status` → `{ initialized: boolean }`。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/server/app.test.ts` 末尾新增（檔案已 import `buildServer`/`loadConfig`/`mkdtemp` 等）：

```typescript
describe("GET /api/world/status", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-status-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("setting.md 不存在 → initialized:false", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }));
    const res = await server.inject({ method: "GET", url: "/api/world/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ initialized: false });
    await server.close();
  });

  it("setting.md 有正常內容 → initialized:true", async () => {
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n真實世界。\n", "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }));
    const res = await server.inject({ method: "GET", url: "/api/world/status" });
    expect(res.json()).toEqual({ initialized: true });
    await server.close();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: FAIL，`/api/world/status` 回 404

- [ ] **Step 3: 寫實作**

在 `app/src/server/app.ts` 第 14 行附近 import 區新增：

```typescript
import { isWorldInitialized } from "../engine/world-status.js";
```

在 `/api/state` 路由（第 139-141 行）之後新增：

```typescript
  // 前端開機判斷：世界是否已初始化（決定要不要顯示初始化精靈）
  server.get("/api/world/status", async () => {
    return { initialized: await isWorldInitialized(config.worldDir) };
  });
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: PASS（既有 + 2 個新測試）

- [ ] **Step 5: Commit**

```bash
git add app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(server): 新增 GET /api/world/status 回報世界初始化狀態"
```

---

## Task 10: `world-ops.ts` + `/api/world/init` 路由

把世界級操作的純邏輯抽到 `app/src/engine/world-ops.ts`，路由層只做 HTTP 包裝（驗證、狀態碼、SSE/JSON）。這樣 init/end/protagonist 的核心邏輯可單獨測試，不必每次都過 Fastify inject。

**Files:**
- Create: `app/src/engine/world-ops.ts`
- Modify: `app/src/server/app.ts`（新增 `/api/world/init` 路由）
- Test: `app/src/server/app.test.ts`（新增 describe 區塊）

**Interfaces:**
- Consumes: `LlmClient`（`streamChat`）、`buildProtagonistPrompt`（Task 4）、`UNINITIALIZED_*_PLACEHOLDER`（Task 1）、`serializeNow`（now.ts）、`NowState`（context.ts）。
- Produces:
  - `WorldInitInput`（`{ preferences?: {...}; protagonistSeed?: ProtagonistSeed }`）
  - `initWorld(opts: { worldDir: string; client: LlmClient; input: WorldInitInput; today: string; logger: Logger }): Promise<void>`——把生成內容全部寫進 worldDir（呼叫端負責 commit/clearRecall）。
  - 一個共用的「整段生成文字」helper `generateText(client, messages): Promise<string>`（內部把 streamChat 收斂成字串）。

- [ ] **Step 1: 寫失敗測試（路由層）**

在 `app/src/server/app.test.ts` 末尾新增：

```typescript
import { isWorldInitialized } from "../engine/world-status.js";

describe("POST /api/world/init", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-init-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    // 未初始化：不寫 setting.md
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("未初始化時成功生成世界，回 GameState，setting.md 變成正常內容", async () => {
    const commits: string[] = [];
    // init 內部依序呼叫 client 三次：setting / gm-notes / protagonist
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["# 世界設定\n\n冷酷系統。\n"]),
      commit: async (m) => { commits.push(m); return true; },
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/world/init",
      payload: { preferences: {}, protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.now).toBeDefined();
    expect(await isWorldInitialized(world)).toBe(true);
    expect(commits).toHaveLength(1);
    await server.close();
  });

  it("已初始化時回 409，不動檔案", async () => {
    await writeFile(path.join(world, "setting.md"), "# 已存在世界\n\n內容。\n", "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["不該被呼叫"]),
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/world/init",
      payload: { preferences: {}, protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});
```

> 註：`fakeClient` 對所有 streamChat 呼叫都回同一組 deltas，所以 setting/gm-notes/protagonist 三次生成會拿到同一段文字，測試只驗證「有寫入、狀態轉為已初始化」，不驗證三段內容差異。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: FAIL，`/api/world/init` 回 404

- [ ] **Step 3: 寫實作 — world-ops.ts**

建立 `app/src/engine/world-ops.ts`：

```typescript
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import type { Logger } from "../logger.js";
import { serializeNow } from "./now.js";
import type { NowState } from "./context.js";
import { buildProtagonistPrompt, type ProtagonistSeed } from "./protagonist-seed.js";

/** 把一次性 streamChat 收斂成完整字串（世界級生成都是非串流場景） */
export async function generateText(client: LlmClient, messages: ChatMessage[]): Promise<string> {
  let full = "";
  for await (const d of client.streamChat(messages)) full += d;
  return full.trim();
}

export interface WorldInitInput {
  preferences?: {
    tone?: string;
    horrorIntensity?: string;
    godPersona?: string;
    protectionRule?: string;
  };
  protagonistSeed?: ProtagonistSeed;
}

const UNSPEC = "（使用者未指定，由你自由發揮）";

/** 起始 now.md 的七欄內容（新世界開局） */
function initialNow(today: string): NowState {
  return {
    chapter: "第一章：開場",
    scene: "主神空間安全區，剛被系統選中",
    companions: "（無）",
    activeDungeon: "無",
    threads: "（待劇情展開）",
    nextStep: "熟悉環境，等待第一個副本公告",
    lastUpdated: `[${today}] 新世界啟用`,
  };
}

/**
 * 生成一個全新世界，把所有檔案寫進 worldDir。呼叫端負責 commit 與清 recall 索引。
 * 失敗時可能留下半套檔案——呼叫端應在 isWorldInitialized 為 false 時才呼叫，
 * 且失敗就不 commit（見路由層）。
 */
export async function initWorld(opts: {
  worldDir: string;
  client: LlmClient;
  input: WorldInitInput;
  today: string;
  logger: Logger;
}): Promise<void> {
  const { worldDir, client, input, today } = opts;
  const pref = input.preferences ?? {};

  // 1) setting.md（玩家可見）
  const settingMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是本世界的設定設計師。依玩家偏好生成玩家可見的世界設定 setting.md（繁體中文）。" +
        "必須包含：主控系統表面樣貌、世界基調、副本機制、新手保護規則、主空間規則、當前篇章。" +
        "只輸出 markdown 正文，開頭是 `# 世界設定（World Setting）`。",
    },
    {
      role: "user",
      content: [
        `基調/可參考作品：${pref.tone?.trim() || UNSPEC}`,
        `恐怖/驚悚強度：${pref.horrorIntensity?.trim() || UNSPEC}`,
        `主神表面性格：${pref.godPersona?.trim() || UNSPEC}`,
        `新手保護規則草案：${pref.protectionRule?.trim() || UNSPEC}`,
      ].join("\n"),
    },
  ]);

  // 2) gm-notes.md（隱藏真相）——只讀 setting.md 結果，不讀玩家原始偏好逐字稿
  const gmNotesMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是本世界的暗線設計師。依玩家可見的 setting.md，自主編寫世界隱藏真相 gm-notes.md（繁體中文）：" +
        "主神真實動機、世界背後真相、最終目的、暗線伏筆。這是劇透文件，玩家永遠不會直接看到。" +
        "只輸出 markdown 正文，開頭是 `# 世界隱藏真相（GM Notes）`。",
    },
    { role: "user", content: `玩家可見設定如下：\n\n${settingMd}` },
  ]);

  // 3) protagonist.md
  const protagonistMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是本世界的角色設計師。生成主角檔案 protagonist.md（繁體中文）：" +
        "基本資訊、初始積分（一般為 0）、初始屬性、技能（通常無）、物品欄、Buff/Debuff、新手保護備註。" +
        "只輸出 markdown 正文，開頭是 `# 主角檔案`。",
    },
    { role: "user", content: buildProtagonistPrompt(input.protagonistSeed ?? {}) },
  ]);

  // 4) 全部寫入（最後才一次性落地，避免半初始化）
  await mkdir(path.join(worldDir, "characters"), { recursive: true });
  await writeFile(path.join(worldDir, "setting.md"), `${settingMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "gm-notes.md"), `${gmNotesMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "characters", "protagonist.md"), `${protagonistMd}\n`, "utf8");
  await writeFile(
    path.join(worldDir, "characters", "index.md"),
    [
      "# 角色索引（Character Index）",
      "",
      "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
      "|----|------|------|----------|--------------|",
      "| protagonist | 主角 | 主角 | 新世界開局 | - |",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "journal.md"),
    `# 主空間日誌（Journal）\n\n## [${today}] 新世界啟用\n\n新世界建立，主角剛被系統選中。\n`,
    "utf8",
  );
  await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");

  // 清空 dungeons/（若有殘留）
  const dungeonsDir = path.join(worldDir, "dungeons");
  await rm(dungeonsDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dungeonsDir, { recursive: true });
}
```

- [ ] **Step 4: 寫實作 — 路由層**

在 `app/src/server/app.ts` import 區新增：

```typescript
import { initWorld } from "../engine/world-ops.js";
import { clearRecallIndex } from "../recall/clear-index.js";
import { todayISO } from "../engine/turn/shared.js";
```

在 `/api/world/status` 路由之後新增：

```typescript
  server.post("/api/world/init", async (req, reply) => {
    if (await isWorldInitialized(config.worldDir)) {
      return reply.code(409).send({ error: "世界已初始化，不可重複初始化" });
    }
    const body = (req.body ?? {}) as import("../engine/world-ops.js").WorldInitInput;
    const opLogger = logger.child({ op: "world-init" });
    await initWorld({
      worldDir: config.worldDir,
      client: makeClient(opLogger),
      input: body,
      today: todayISO(),
      logger: opLogger,
    });
    await makeCommit(opLogger)("重置世界、生成新設定");
    await clearRecallIndex(config.recall);
    return loadState(config.worldDir, opLogger);
  });
```

> `makeClient`/`makeCommit` 已在 buildServer 內定義（第 47、110 行）；`loadState` 已 import。

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: PASS（既有 + 2 個新測試）

- [ ] **Step 6: 全量測試 + commit**

Run: `cd app && npm test`
Expected: 全綠

```bash
git add app/src/engine/world-ops.ts app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(server): 新增 POST /api/world/init 全自動生成新世界"
```

---

## Task 11: `endWorld` + `/api/world/end` 路由

**Files:**
- Modify: `app/src/engine/world-ops.ts`（新增 `endWorld`）
- Modify: `app/src/server/app.ts`（新增 `/api/world/end` 路由）
- Test: `app/src/server/app.test.ts`（新增 describe 區塊）

**Interfaces:**
- Consumes: `archiveWorld`（Task 2）、`UNINITIALIZED_*_PLACEHOLDER`（Task 1）、`generateText`/`initialNow`（已在 world-ops.ts）、`existsSync`（node:fs）。
- Produces: `resetWorldToPlaceholder(worldDir, today)`（覆寫式重置 world/ 回未初始化佔位）、`endWorld(opts): Promise<string>`（封存 + 寫 summary + 重置；回傳 archivedTo 相對路徑）。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/server/app.test.ts` 末尾新增：

```typescript
describe("POST /api/world/end", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-end-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n真實世界。\n", "utf8");
    await writeFile(path.join(world, "gm-notes.md"), "# 隱藏真相\n\n秘密。\n", "utf8");
    await writeFile(path.join(world, "now.md"), "- 當前篇章：終章\n- 進行中的副本：無\n- 最後更新：[2026-06-23] x\n", "utf8");
    await writeFile(path.join(world, "journal.md"), "# 日誌\n\n劇情。\n", "utf8");
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n", "utf8");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("confirmText 不符 → 400，不動世界", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), { client: fakeClient(["摘要"]) });
    const res = await server.inject({
      method: "POST", url: "/api/world/end", payload: { confirmText: "刪除" },
    });
    expect(res.statusCode).toBe(400);
    expect(await isWorldInitialized(world)).toBe(true);
    await server.close();
  });

  it("confirmText 為「封存」→ 封存並重置 setting.md 回佔位狀態", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["這是故事的終章摘要。"]),
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/world/end", payload: { confirmText: "封存" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedTo).toMatch(/^archives\//);
    expect(await isWorldInitialized(world)).toBe(false);
    await server.close();
  });

  it("world/.pending-death 存在時 → 409（先走死亡抉擇）", async () => {
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }), { client: fakeClient(["摘要"]) });
    const res = await server.inject({
      method: "POST", url: "/api/world/end", payload: { confirmText: "封存" },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: FAIL，`/api/world/end` 回 404

- [ ] **Step 3: 寫實作 — world-ops.ts**

在 `app/src/engine/world-ops.ts` import 區補上：

```typescript
import { archiveWorld } from "./archive.js";
import {
  UNINITIALIZED_SETTING_PLACEHOLDER,
  UNINITIALIZED_GM_NOTES_PLACEHOLDER,
} from "./world-status.js";
```

在檔案末尾新增：

```typescript
/** 把 world/ 重置回「尚未初始化」佔位狀態（覆寫式） */
export async function resetWorldToPlaceholder(worldDir: string, today: string): Promise<void> {
  await mkdir(path.join(worldDir, "characters"), { recursive: true });
  await writeFile(path.join(worldDir, "setting.md"), UNINITIALIZED_SETTING_PLACEHOLDER, "utf8");
  await writeFile(path.join(worldDir, "gm-notes.md"), UNINITIALIZED_GM_NOTES_PLACEHOLDER, "utf8");
  await writeFile(
    path.join(worldDir, "characters", "protagonist.md"),
    "# 主角檔案\n\n> 尚未初始化。\n",
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "characters", "index.md"),
    "# 角色索引（Character Index）\n\n| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |\n|----|------|------|----------|--------------|\n",
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "journal.md"),
    `# 主空間日誌（Journal）\n\n> 尚未初始化。\n`,
    "utf8",
  );
  await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");
  const dungeonsDir = path.join(worldDir, "dungeons");
  await rm(dungeonsDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dungeonsDir, { recursive: true });
}

/**
 * 封存目前世界：生成終章摘要 → archiveWorld → 寫 summary.md → 重置回佔位。
 * 回傳 archivedTo（相對 repoRoot 的封存目錄）。摘要生成失敗以固定文字降級，不中止封存。
 */
export async function endWorld(opts: {
  repoRoot: string;
  worldDir: string;
  client: LlmClient;
  today: string;
  logger: Logger;
}): Promise<string> {
  const { repoRoot, worldDir, client, today, logger } = opts;
  const readSafe = async (rel: string): Promise<string> => {
    try {
      return await readFile(path.join(worldDir, rel), "utf8");
    } catch {
      return "";
    }
  };

  let summary: string;
  try {
    // 摘要 prompt 只讀 setting + journal/now/protagonist，不讀 gm-notes（避免劇透寫進 archives）
    summary = await generateText(client, [
      {
        role: "system",
        content:
          "你是說書人。依下列已發生的劇情，寫一篇故事終章摘要（繁體中文，數百字）。" +
          "只根據提供的內容，不要杜撰未提及的隱藏真相。",
      },
      {
        role: "user",
        content: [
          `世界設定：\n${await readSafe("setting.md")}`,
          `當前局勢：\n${await readSafe("now.md")}`,
          `主角：\n${await readSafe("characters/protagonist.md")}`,
          `日誌：\n${await readSafe("journal.md")}`,
        ].join("\n\n---\n\n"),
      },
    ]);
    if (!summary) summary = "（摘要生成失敗）";
  } catch (err) {
    logger.warn({ err }, "終章摘要生成失敗，以固定文字降級");
    summary = "（摘要生成失敗）";
  }

  const archivedTo = await archiveWorld(repoRoot, worldDir);
  await writeFile(path.join(repoRoot, archivedTo, "summary.md"), `# 終章摘要\n\n${summary}\n`, "utf8");
  await resetWorldToPlaceholder(worldDir, today);
  return archivedTo;
}
```

> `repoRoot` 在路由層用 `path.dirname(config.worldDir)`（與 app.ts 第 45 行 `repoRoot` 一致）。

- [ ] **Step 4: 寫實作 — 路由層**

在 `app/src/server/app.ts` import 區補上（`existsSync` 已 import 於第 1 行）：

```typescript
import { endWorld } from "../engine/world-ops.js";
```

> 注意：與 Task 10 的 `import { initWorld } from "../engine/world-ops.js"` 合併成一行 `import { initWorld, endWorld } from "../engine/world-ops.js";`

在 `/api/world/init` 路由之後新增：

```typescript
  server.post("/api/world/end", async (req, reply) => {
    if (existsSync(path.join(config.worldDir, ".pending-death"))) {
      return reply.code(409).send({ error: "請先完成主角換代或結束世界的抉擇" });
    }
    const confirmText = (req.body as { confirmText?: string })?.confirmText;
    if (confirmText !== "封存") {
      return reply.code(400).send({ error: "確認文字不符" });
    }
    const opLogger = logger.child({ op: "world-end" });
    const archivedTo = await endWorld({
      repoRoot,
      worldDir: config.worldDir,
      client: makeClient(opLogger),
      today: todayISO(),
      logger: opLogger,
    });
    await makeCommit(opLogger)("封存世界");
    await clearRecallIndex(config.recall);
    return { archivedTo };
  });
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: PASS（既有 + 3 個新測試）

- [ ] **Step 6: 全量測試 + commit**

Run: `cd app && npm test`
Expected: 全綠

```bash
git add app/src/engine/world-ops.ts app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(server): 新增 POST /api/world/end 封存世界並重置回佔位狀態"
```

---

## Task 12: `/api/world/protagonist` 路由（換代/結束）+ `/api/turn` 前置檢查

**Files:**
- Modify: `app/src/engine/world-ops.ts`（新增 `replaceProtagonist`）
- Modify: `app/src/server/app.ts`（新增 `/api/world/protagonist` 路由；`/api/turn` 加 `.pending-death` 前置檢查）
- Test: `app/src/server/app.test.ts`（新增 describe 區塊）

**Interfaces:**
- Consumes: `archiveWorldFiles`（Task 2）、`buildProtagonistPrompt`（Task 4）、`generateText`/`initialNow`（world-ops.ts）、`endWorld`（Task 11）。
- Produces: `replaceProtagonist(opts): Promise<void>`（封存舊主角檔案 + 生成新主角 + 重置主空間時間線，不動 setting/gm-notes/dungeons）；`POST /api/world/protagonist`；`/api/turn` 前置 sentinel 檢查。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/server/app.test.ts` 末尾新增：

```typescript
describe("POST /api/world/protagonist", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-prot-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 世界設定\n\n真實世界。\n", "utf8");
    await writeFile(path.join(world, "gm-notes.md"), "# 隱藏真相\n\n秘密。\n", "utf8");
    await writeFile(path.join(world, "now.md"), "- 當前篇章：終章\n- 進行中的副本：無\n- 最後更新：[2026-06-23] x\n", "utf8");
    await writeFile(path.join(world, "journal.md"), "# 日誌\n\n舊主角劇情。\n", "utf8");
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n", "utf8");
    await writeFile(path.join(world, "characters", "index.md"), "| ID | 姓名 |\n| protagonist | 沈奕 |\n", "utf8");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("無 .pending-death → 409", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), { client: fakeClient(["x"]) });
    const res = await server.inject({
      method: "POST", url: "/api/world/protagonist",
      payload: { choice: "keep-world", protagonistSeed: {} },
    });
    expect(res.statusCode).toBe(409);
    await server.close();
  });

  it("keep-world：封存舊主角檔（含 now.md）、生成新主角、刪 .pending-death、保留 setting/gm-notes", async () => {
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
    const settingBefore = await readFile(path.join(world, "setting.md"), "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["# 主角檔案\n- 姓名：新主角\n- 當前積分：0\n"]),
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/world/protagonist",
      payload: { choice: "keep-world", protagonistSeed: { name: "新主角" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().now).toBeDefined();
    // setting/gm-notes 不動
    expect(await readFile(path.join(world, "setting.md"), "utf8")).toBe(settingBefore);
    // .pending-death 已刪
    await expect(readFile(path.join(world, ".pending-death"), "utf8")).rejects.toThrow();
    await server.close();
  });

  it("end-world：等同封存（免 confirmText），切回未初始化，刪 .pending-death", async () => {
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["終章摘要。"]),
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/world/protagonist", payload: { choice: "end-world" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().archivedTo).toMatch(/^archives\//);
    expect(await isWorldInitialized(world)).toBe(false);
    await expect(readFile(path.join(world, ".pending-death"), "utf8")).rejects.toThrow();
    await server.close();
  });
});

describe("POST /api/turn 在 .pending-death 存在時擋下", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-turn-block-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 設定\n", "utf8");
    await writeFile(path.join(world, "now.md"), "- 當前篇章：第一章\n- 進行中的副本：無\n- 最後更新：[2026-06-18] 舊\n", "utf8");
    await writeFile(path.join(world, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：0\n", "utf8");
    await writeFile(path.join(world, ".pending-death"), new Date().toISOString(), "utf8");
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("回 error event，不呼叫 client.streamChat", async () => {
    let called = false;
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: { async *streamChat() { called = true; yield "x"; } },
      commit: async () => true,
    });
    const res = await server.inject({
      method: "POST", url: "/api/turn", payload: { input: "行動" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"error"');
    expect(res.body).toContain("主角已死亡");
    expect(called).toBe(false);
    await server.close();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: FAIL，protagonist 路由 404、turn 未擋下（client 被呼叫）

- [ ] **Step 3: 寫實作 — world-ops.ts replaceProtagonist**

在 `app/src/engine/world-ops.ts` import 區補上 `archiveWorldFiles`：

```typescript
import { archiveWorld, archiveWorldFiles } from "./archive.js";
```

在檔案末尾新增：

```typescript
/**
 * 主角換代（保留世界）：封存舊主角相關檔案（含 now.md）→ 寫前任退場摘要 →
 * 生成新主角 → 重置主空間時間線（journal/now/index 的主角列）。
 * 不動 setting.md/gm-notes.md/dungeons/*。回傳封存目錄相對路徑。
 */
export async function replaceProtagonist(opts: {
  repoRoot: string;
  worldDir: string;
  client: LlmClient;
  protagonistSeed: ProtagonistSeed;
  today: string;
  logger: Logger;
}): Promise<string> {
  const { repoRoot, worldDir, client, protagonistSeed, today, logger } = opts;
  const readSafe = async (rel: string): Promise<string> => {
    try { return await readFile(path.join(worldDir, rel), "utf8"); } catch { return ""; }
  };

  // 1) 前任退場摘要（讀 journal/protagonist，不讀 gm-notes）
  let farewell: string;
  try {
    farewell = await generateText(client, [
      { role: "system", content: "你是說書人。為退場的前任主角寫一段簡短退場摘要（繁體中文）。只依提供內容，不杜撰隱藏真相。" },
      { role: "user", content: `主角：\n${await readSafe("characters/protagonist.md")}\n\n日誌：\n${await readSafe("journal.md")}` },
    ]);
    if (!farewell) farewell = "（摘要生成失敗）";
  } catch (err) {
    logger.warn({ err }, "前任主角退場摘要生成失敗，以固定文字降級");
    farewell = "（摘要生成失敗）";
  }

  // 2) 封存舊主角檔（含 now.md 死亡瞬間快照）
  const archivedTo = await archiveWorldFiles(repoRoot, worldDir, [
    "characters/protagonist.md",
    "characters/index.md",
    "journal.md",
    "now.md",
  ]);
  await writeFile(path.join(repoRoot, archivedTo, "summary.md"), `# 前任主角退場摘要\n\n${farewell}\n`, "utf8");

  // 3) 生成新主角
  const protagonistMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是本世界的角色設計師。生成接替主角的 protagonist.md（繁體中文）：" +
        "基本資訊、初始積分（一般為 0）、初始屬性、技能、物品欄、Buff/Debuff、新手保護備註。" +
        "可沿用既有世界觀。只輸出 markdown，開頭是 `# 主角檔案`。",
    },
    { role: "user", content: buildProtagonistPrompt(protagonistSeed) },
  ]);

  // 4) 重置主空間時間線（不動 setting/gm-notes/dungeons）
  await writeFile(path.join(worldDir, "characters", "protagonist.md"), `${protagonistMd}\n`, "utf8");
  await writeFile(
    path.join(worldDir, "characters", "index.md"),
    [
      "# 角色索引（Character Index）",
      "",
      "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
      "|----|------|------|----------|--------------|",
      "| protagonist | 新主角 | 主角 | 接替前任，新開局 | - |",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "journal.md"),
    `# 主空間日誌（Journal）\n\n## [${today}] 新主角接替\n\n前任主角已退場，新主角接續這個世界。\n`,
    "utf8",
  );
  await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");
  return archivedTo;
}
```

- [ ] **Step 4: 寫實作 — 路由層 protagonist**

在 `app/src/server/app.ts` import 區把 world-ops import 補成：

```typescript
import { initWorld, endWorld, replaceProtagonist } from "../engine/world-ops.js";
```

新增 `node:fs/promises` 的 `rm`（檔案頂部目前未 import fs/promises；用動態 import 或在頂部加）。在頂部 import 區新增：

```typescript
import { rm } from "node:fs/promises";
```

在 `/api/world/end` 路由之後新增：

```typescript
  server.post("/api/world/protagonist", async (req, reply) => {
    const pendingPath = path.join(config.worldDir, ".pending-death");
    if (!existsSync(pendingPath)) {
      return reply.code(409).send({ error: "目前不在主角死亡抉擇情境" });
    }
    const body = req.body as
      | { choice: "keep-world"; protagonistSeed?: import("../engine/protagonist-seed.js").ProtagonistSeed }
      | { choice: "end-world" };
    const opLogger = logger.child({ op: "world-protagonist" });

    if (body.choice === "end-world") {
      const archivedTo = await endWorld({
        repoRoot, worldDir: config.worldDir, client: makeClient(opLogger),
        today: todayISO(), logger: opLogger,
      });
      await rm(pendingPath, { force: true });
      await makeCommit(opLogger)("封存世界");
      await clearRecallIndex(config.recall);
      return { archivedTo };
    }

    // keep-world
    await replaceProtagonist({
      repoRoot, worldDir: config.worldDir, client: makeClient(opLogger),
      protagonistSeed: body.protagonistSeed ?? {}, today: todayISO(), logger: opLogger,
    });
    await rm(pendingPath, { force: true });
    await makeCommit(opLogger)("主角換代");
    await clearRecallIndex(config.recall);
    return loadState(config.worldDir, opLogger);
  });
```

- [ ] **Step 5: 寫實作 — /api/turn 前置檢查**

在 `app/src/server/app.ts` 的 `/api/turn` route handler 內，`const input = ...`（第 145 行）之後、`reply.hijack()`（第 149 行）之前插入：

```typescript
    if (existsSync(path.join(config.worldDir, ".pending-death"))) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", message: "主角已死亡，請先完成換代或封存抉擇" })}\n\n`,
      );
      reply.raw.end();
      return;
    }
```

- [ ] **Step 6: 跑測試確認通過**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: PASS（既有 + 4 個新測試）

- [ ] **Step 7: 全量測試 + commit**

Run: `cd app && npm test`
Expected: 全綠

```bash
git add app/src/engine/world-ops.ts app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(server): 新增 POST /api/world/protagonist 換代/結束，/api/turn 死亡前置擋"
```

---

## Task 13: 前端開機判斷、初始化精靈、死亡抉擇 modal、危險區域

本專案前端無自動化測試框架，本 Task 以 `npx tsc --noEmit` 型別檢查 + 人工 dev server 驗證（執行階段檢查清單列於 Step 末）為驗證手段。

**Files:**
- Create: `app/web/src/WorldSetupWizard.tsx`
- Create: `app/web/src/DeathChoiceModal.tsx`
- Modify: `app/web/src/App.tsx`（開機判斷、done 事件處理、StatusDrawer 危險區域、composer/按鈕停用）

**Interfaces:**
- Consumes: `fetchWorldStatus`/`initWorld`/`endWorld`/`resolveProtagonistDeath`/`WorldInitRequest`/`ProtagonistSeed`/`GameState`（Task 8）。

- [ ] **Step 1: 建立 `WorldSetupWizard.tsx`**

```tsx
import { useState } from "react";
import { initWorld, type GameState, type WorldInitRequest } from "./api";

const COMPUTING_HINT = "🌌 主控系統正在生成新世界…（自架模型可能需數十秒，請稍候）";

export function WorldSetupWizard({ onDone }: { onDone: (state: GameState) => void }) {
  const [tone, setTone] = useState("");
  const [horrorIntensity, setHorrorIntensity] = useState("");
  const [godPersona, setGodPersona] = useState("");
  const [protectionRule, setProtectionRule] = useState("");
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [freeform, setFreeform] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    const body: WorldInitRequest = {
      preferences: { tone, horrorIntensity, godPersona, protectionRule },
      protagonistSeed: { name, origin, freeform },
    };
    try {
      const state = await initWorld(body);
      onDone(state);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="app-shell app-shell--main">
      <div className="layout">
        <header className="topbar">
          <div className="brand"><span className="brand-mark">∞</span><h1>建立新世界</h1></div>
        </header>
        <main className="story-col">
          <section className="story-card">
            <p className="story-eyebrow">WORLD SETUP</p>
            <p>所有欄位皆可留空——留空的部分交由主控系統自由發揮。</p>
            <label>基調 / 可參考作品<textarea value={tone} disabled={busy} onChange={(e) => setTone(e.target.value)} /></label>
            <label>恐怖 / 驚悚強度<input value={horrorIntensity} disabled={busy} onChange={(e) => setHorrorIntensity(e.target.value)} /></label>
            <label>主神表面性格<input value={godPersona} disabled={busy} onChange={(e) => setGodPersona(e.target.value)} /></label>
            <label>新手保護規則<textarea value={protectionRule} disabled={busy} onChange={(e) => setProtectionRule(e.target.value)} /></label>
            <hr />
            <label>主角姓名<input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
            <label>主角出身<textarea value={origin} disabled={busy} onChange={(e) => setOrigin(e.target.value)} /></label>
            <label>自由描述<textarea value={freeform} disabled={busy} onChange={(e) => setFreeform(e.target.value)} /></label>
            <button className="send-btn" disabled={busy} onClick={submit}>
              {busy ? "生成中…" : "建立世界"}
            </button>
            {busy && <div className="computing-hint">{COMPUTING_HINT}</div>}
            {error && <div className="story-text">[錯誤] {error}</div>}
          </section>
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 建立 `DeathChoiceModal.tsx`**

```tsx
import { useState } from "react";
import { resolveProtagonistDeath, type GameState, type ProtagonistSeed } from "./api";

interface Props {
  onKeepWorldDone: (state: GameState) => void;
  onEndWorldDone: () => void;
}

export function DeathChoiceModal({ onKeepWorldDone, onEndWorldDone }: Props) {
  const [mode, setMode] = useState<"choose" | "keep-form" | "end-confirm">("choose");
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [freeform, setFreeform] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function keepWorld() {
    if (busy) return;
    setBusy(true); setError("");
    const seed: ProtagonistSeed = { name, origin, freeform };
    try {
      const result = await resolveProtagonistDeath({ choice: "keep-world", protagonistSeed: seed });
      onKeepWorldDone(result as GameState);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function endWorld() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await resolveProtagonistDeath({ choice: "end-world" });
      onEndWorldDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="drawer-backdrop">
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header"><h2>主角已永久死亡</h2></div>
        {mode === "choose" && (
          <div className="suggested">
            <button className="chip" disabled={busy} onClick={() => setMode("keep-form")}>保留這個世界，新主角接續</button>
            <button className="chip" disabled={busy} onClick={() => setMode("end-confirm")}>結束這個世界</button>
          </div>
        )}
        {mode === "keep-form" && (
          <section className="panel">
            <label>新主角姓名<input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
            <label>出身<textarea value={origin} disabled={busy} onChange={(e) => setOrigin(e.target.value)} /></label>
            <label>自由描述<textarea value={freeform} disabled={busy} onChange={(e) => setFreeform(e.target.value)} /></label>
            <button className="send-btn" disabled={busy} onClick={keepWorld}>{busy ? "生成中…" : "確認接續"}</button>
          </section>
        )}
        {mode === "end-confirm" && (
          <section className="panel">
            <p>確定要結束這個世界嗎？此動作會封存整個世界並回到初始化畫面。</p>
            <button className="chip" disabled={busy} onClick={() => setMode("choose")}>取消</button>
            <button className="send-btn" disabled={busy} onClick={endWorld}>{busy ? "封存中…" : "確定結束"}</button>
          </section>
        )}
        {error && <div className="story-text">[錯誤] {error}</div>}
      </aside>
    </div>
  );
}
```

- [ ] **Step 3: 修改 `App.tsx` — 開機判斷**

在 `App.tsx` 頂部 import 補：

```tsx
import { fetchWorldStatus, endWorld } from "./api";
import { WorldSetupWizard } from "./WorldSetupWizard";
import { DeathChoiceModal } from "./DeathChoiceModal";
```

在 `App()` 內 state 區新增：

```tsx
  const [worldInitialized, setWorldInitialized] = useState<boolean | null>(null);
  const [protagonistDied, setProtagonistDied] = useState(false);
```

在第一個 `useEffect`（第 34 行）開頭，先打 status：

```tsx
    fetchWorldStatus()
      .then((s) => setWorldInitialized(s.initialized))
      .catch(() => setWorldInitialized(true)); // 失敗時保守當已初始化，至少能進主畫面
```

在 `App()` 的 return 之前，加分支渲染：

```tsx
  if (worldInitialized === null) return <div className="app-shell app-shell--main" />;
  if (!worldInitialized) {
    return <WorldSetupWizard onDone={(s) => { setState(s); setWorldInitialized(true); loadedInitialRef.current = true; }} />;
  }
```

- [ ] **Step 4: 修改 `App.tsx` — done 事件處理死亡**

在 `streamTurn` 的 `case "done":`（第 92-95 行）內，新增 `protagonistDied` 判斷：

```tsx
          case "done":
            if (ev.protagonistDied) {
              setProtagonistDied(true);
              setSuggested([]); // 死亡時不顯示建議行動 chips
            } else {
              setSuggested(ev.suggestedActions ?? []);
            }
            if (ev.state) setState(ev.state);
            break;
```

- [ ] **Step 5: 修改 `App.tsx` — composer 停用、modal 渲染、危險區域**

把 composer 的 input/button 的 `disabled={busy}` 改成 `disabled={busy || protagonistDied}`（第 202、209 行）。建議行動 chips 區（第 188 行）改成 `{suggested.length > 0 && !protagonistDied && (`。

在最外層 return 的 `{showStatus && state && (...)}`（第 229 行）之後新增死亡 modal：

```tsx
      {protagonistDied && (
        <DeathChoiceModal
          onKeepWorldDone={(s) => { setState(s); setProtagonistDied(false); setStory("新主角接替了這個世界。"); }}
          onEndWorldDone={() => { setProtagonistDied(false); setWorldInitialized(false); }}
        />
      )}
```

在 `StatusDrawer` 元件（第 245 行）新增「封存故事 / 結束世界」按鈕與危險區域。把簽章改為接收 `onEndWorld`、`disabled`：

```tsx
function StatusDrawer({
  state, onClose, onEndWorld, dangerDisabled,
}: {
  state: GameState;
  onClose: () => void;
  onEndWorld: () => void;
  dangerDisabled: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <h2>角色 / 系統面板</h2>
          <button className="icon-btn" aria-label="關閉面板" onClick={onClose}><IconClose /></button>
        </div>
        <StatusPanel state={state} />
        <NpcPanel state={state} />
        <section className="panel">
          <div className="panel-head"><h2>危險區域</h2></div>
          {!confirming ? (
            <button className="chip" disabled={dangerDisabled} onClick={() => setConfirming(true)}>
              封存故事 / 結束世界
            </button>
          ) : (
            <>
              <p>輸入「封存」以確認結束並封存目前世界：</p>
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
              <button className="send-btn" disabled={confirmText !== "封存"} onClick={onEndWorld}>確定封存</button>
            </>
          )}
        </section>
      </aside>
    </div>
  );
}
```

並把 App return 內 StatusDrawer 的呼叫（第 230 行）改為傳入新 props，且封存成功後切回未初始化：

```tsx
      {showStatus && state && (
        <StatusDrawer
          state={state}
          onClose={() => setShowStatus(false)}
          dangerDisabled={busy || protagonistDied}
          onEndWorld={async () => {
            try { await endWorld("封存"); setShowStatus(false); setWorldInitialized(false); }
            catch (e) { setStory((s) => s + `\n[錯誤] ${(e as Error).message}\n`); }
          }}
        />
      )}
```

> 注意：`StatusDrawer` 用到 `useState`，需確認 `App.tsx` 第 1 行 import 已含 `useState`（是）。

- [ ] **Step 6: 型別檢查**

Run: `cd app && npx tsc -p tsconfig.json --noEmit`
Expected: 無錯誤

- [ ] **Step 7: 人工驗證清單（dev server）**

Run: `cd app && npm run build`（確認前端能 build 過）
Expected: build 成功，無型別錯誤

人工驗證（可選，需設定 LLM 端點）：
1. 把 `world/setting.md` 暫時改成佔位文字 → 重整頁面應出現 `WorldSetupWizard`。
2. 全部留空送出 → 應生成新世界並進主畫面。
3. 開面板 → 危險區域輸入「封存」→ 應切回精靈頁。

- [ ] **Step 8: Commit**

```bash
git add app/web/src/WorldSetupWizard.tsx app/web/src/DeathChoiceModal.tsx app/web/src/App.tsx
git commit -m "feat(web): 開機判斷未初始化精靈、死亡抉擇 modal、危險區域封存"
```

---

## Self-Review 結果

**1. Spec 覆蓋對照**

| Spec 章節 | 對應 Task |
|-----------|-----------|
| §1 World 狀態判斷 / `GET /api/world/status` | Task 1 + Task 9 |
| §2 Archive 路徑格式 | Task 2 |
| §3 `POST /api/world/init`（含 recall 清除） | Task 4 + Task 10 |
| §4 `POST /api/world/end`（含 .pending-death 409、recall 清除） | Task 11 |
| §5a Schema `protagonist_permanent_death` | Task 5 |
| §5b turn-core 行為（sentinel、now 覆寫、強制暫停、done.protagonistDied） | Task 6 |
| §5b .gitignore | Task 7 |
| §5c `/api/turn` 前置檢查 | Task 12 Step 5 |
| §5d `POST /api/world/protagonist`（keep/end，end 免 confirmText，now.md 封存） | Task 12 |
| §6 `ProtagonistSeed`/`buildProtagonistPrompt` | Task 4 |
| §7 Recall 索引處理（共用 clearRecallIndex） | Task 3 + Task 10/11/12 呼叫 |
| 前端開機判斷 / WorldSetupWizard | Task 13 |
| 前端 StatusDrawer 危險區域（死亡期間停用） | Task 13 Step 5 |
| 前端死亡抉擇 modal（end 按鈕確認、composer 停用） | Task 13 |
| 前端 api.ts 新增 + 型別漂移修正 | Task 8 |
| 測試策略各檔 | Task 1-6、9-12 各自的測試 step |

**2. Placeholder 掃描**：無 TODO/TBD/「類似 Task N」等紅旗（程式碼皆完整給出；「待劇情揭露」「（摘要生成失敗）」是設計上的執行期文案，非計畫佔位）。

**3. 型別一致性**：
- `clearRecallIndex` 全程同名（Task 3 定義、Task 10/11/12 呼叫）。
- `ProtagonistSeed` 在 Task 4（後端）與 Task 8（前端鏡像）形狀一致（name/origin/freeform 皆 optional）。
- `protagonistDied` 在 Task 6（types.ts done 分支，必填 boolean）與 Task 8（api.ts 鏡像，必填 boolean）一致。
- `archiveWorld`/`archiveWorldFiles` 簽章在 Task 2 定義時加了第 3/4 參數 `now: Date = new Date()`（測試注入固定時間），Task 11/12 呼叫時省略該參數走預設，相容。
- `generateText`/`initialNow`/`resetWorldToPlaceholder` 在 world-ops.ts 內共用，跨 Task 10/11/12 同名。

**4. 歧義檢查**：
- `repoRoot` 在路由層一律用 app.ts 既有的 `path.dirname(config.worldDir)`（第 45 行已定義為 `repoRoot`），Task 10-12 直接引用該變數，不重新計算。
- `world-ops.ts` 的 `readFile` 在 Task 10 即靜態 import，Task 11/12 的 `readSafe` 直接用，不再動態 import。

---

## 範圍外（與 spec 一致）

- 不實作天賦/屬性點數分配設定頁，只在 `ProtagonistSeed`/`buildProtagonistPrompt` 保留擴充位。
- 不支援世界初始化的多輪對話式草稿確認（全自動單表單）。
- 不開放「主角換代」作為玩家可隨時手動觸發的功能；只能由 `protagonist_permanent_death` 觸發。
- 不引入第二個並行世界/主角。
- 不處理 `archives/` 目錄的清理/容量管理。
