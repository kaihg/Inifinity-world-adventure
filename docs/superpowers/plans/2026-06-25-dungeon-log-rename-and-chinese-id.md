# 副本 log rename + 中文 ID 支援 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 結算後把 `log.md` rename 成 `log-run-N.md`（每次進入獨立記錄），並開放 dungeonId / NPC id / entity id 使用中文顯示名稱。

**Architecture:**
兩個獨立 task。Task 1 修改 `dungeon.ts` 的 `enterDungeon`（改從計數 `log-run-*.md` 決定序號）與 `appendLog`（改讀 `log.md`，不變），並新增 `renameLogAfterSettle`，在 `turn/index.ts` 的 `settle_dungeon` 處呼叫。Task 2 放寬所有 id 驗證正則（允許 Unicode 中文字，只擋路徑穿越字元），並在 `enterDungeon` / `rewriteNpcFile` / `rewriteLoreEntity` 落地前 `toTraditional()`，同步更新 prompt 說明文字。

**Tech Stack:** Node.js, TypeScript, Vitest

## Global Constraints

- TypeScript，無 `any`，`tsc --noEmit` 零錯誤
- 全套 `cd app && npx vitest run` 通過
- 函式不可 mutate 傳入參數
- 路徑穿越防護必須保留：id 不可含 `/`、`\`、`..`、null byte
- `log.md` 永遠代表「當次進入的即時記錄」；歷史記錄為 `log-run-N.md`

---

## 檔案對應

**Task 1：**
- Modify: `app/src/engine/dungeon.ts`
- Modify: `app/src/engine/dungeon.test.ts`
- Modify: `app/src/engine/turn/index.ts`
- Modify: `app/src/engine/context.ts`（`loadLastTurn` 的 `rawFilePath`）

**Task 2：**
- Modify: `app/src/engine/context.ts`（`NPC_ID_RE`、`rewriteNpcFile`）
- Modify: `app/src/engine/turn/lore-rewrite.ts`（`ITEM_ID_RE`）
- Modify: `app/src/engine/turn/lore-sync-validate.ts`（`sanitizeTouchedEntities`、`HAS_ALNUM_RE`、黑名單）
- Modify: `app/src/engine/turn/prompts.ts`（`LORE_SYNC_FORMAT_BLOCK`、`announced_dungeon` 說明）
- Modify: `app/src/engine/dungeon.ts`（`enterDungeon` 落地前繁體化 dungeonId）
- Modify: `app/src/engine/turn/lore-sync-validate.test.ts`
- Modify: `app/src/engine/context.test.ts`

---

## Task 1：log rename（enterDungeon + renameLogAfterSettle）

**Interfaces:**
- Produces:
  - `enterDungeon(...)` → 讀 `log-run-*.md` 數量決定 runNumber，建新的 `log.md`
  - `renameLogAfterSettle(worldDir: string, dungeonId: string): Promise<void>` — 結算時把 `log.md` rename 成 `log-run-N.md`（N = 現有 `log-run-*.md` 數量 + 1）
  - `context.ts` 的 `loadLastTurn`：副本中讀 `log.md`（已是現況，不變）

- [ ] **Step 1: 確認基線**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/dungeon.test.ts
```

Expected: PASS

- [ ] **Step 2: 修改 `dungeon.ts` — `nextRunNumber` 改從 `log-run-*.md` 計數**

移除舊的 `nextRunNumber`（讀 log.md 內容），改為新函式 `countLogRuns`（計數目錄內 `log-run-*.md`）：

```typescript
import { writeFile, appendFile, mkdir, readFile, readdir, rename } from "node:fs/promises";

/** 計算 dungeons/<id>/ 底下現有的 log-run-*.md 數量，決定下一個 run 序號 */
async function countLogRuns(dir: string): Promise<number> {
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  return files.filter((f) => /^log-run-\d+\.md$/.test(f)).length;
}
```

修改 `enterDungeon`：

```typescript
export async function enterDungeon(
  worldDir: string,
  params: EnterDungeonParams,
  logger: Logger = defaultLogger,
): Promise<ActiveDungeon> {
  const dir = dungeonDir(worldDir, params.dungeonId);
  await mkdir(dir, { recursive: true });

  const runNumber = (await countLogRuns(dir)) + 1;
  const runId = `run-${runNumber}`;
  logger.info({ dungeonId: params.dungeonId, runId }, "進入副本");

  const logFile = path.join(dir, "log.md");
  const header = [
    `# 副本 ${params.dungeonId} · ${runId}（${params.today}）`,
    "",
    `- 進入時角色狀態：${toTraditional(params.protagonistSummary)}`,
    `- 本次目標：${toTraditional(params.goal)}`,
    "",
    "---",
    "",
  ].join("\n");

  await writeFile(logFile, header, "utf8");

  await ensureSecrets(worldDir, "dungeons", params.dungeonId, params.secretsText, `副本隱藏真相（${params.dungeonId}）`, logger);

  return { dungeonId: params.dungeonId, runId };
}
```

新增 `renameLogAfterSettle`：

```typescript
/**
 * 結算後把當次 log.md rename 成 log-run-N.md（N = 現有 log-run-*.md 數量 + 1）。
 * log.md 不存在時靜默略過（防禦：副本進入前結算或重複結算）。
 */
export async function renameLogAfterSettle(
  worldDir: string,
  dungeonId: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  const dir = dungeonDir(worldDir, dungeonId);
  const logFile = path.join(dir, "log.md");
  const n = (await countLogRuns(dir)) + 1;
  const dest = path.join(dir, `log-run-${n}.md`);
  try {
    await rename(logFile, dest);
    logger.info({ dungeonId, dest }, "副本 log.md rename 完成");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
}
```

移除舊的 `nextRunNumber` export（改由 `countLogRuns` 內部使用）。

- [ ] **Step 3: 修改 `turn/index.ts` — settle_dungeon 呼叫 renameLogAfterSettle**

在 `index.ts` 頂部加 import：
```typescript
import { appendLog, enterDungeon, formatActiveDungeon, listDungeonIds, loadDungeonLore, parseActiveDungeon, renameLogAfterSettle } from "../dungeon.js";
```

在 `runTurnLoop` 的 `settle_dungeon` 處理（約第 234 行）：

```typescript
if (done.modeTransition === "settle_dungeon") {
  log.info({ dungeonId: state.now.activeDungeon }, "觸發 mode_transition：settle_dungeon");
  await deps.pendingLoreSync?.promise;
  // 結算前把當次 log.md rename 成 log-run-N.md
  const activeForSettle = parseActiveDungeon(state.now.activeDungeon);
  if (activeForSettle) {
    await renameLogAfterSettle(deps.worldDir, activeForSettle.dungeonId, log);
  }
  await setNowActiveDungeon(deps.worldDir, "無", { date: today, summary: "副本結算，返回安全區" });
  await deps.commit("副本結算，返回安全區");
  yield { type: "transition", to: "main-space" };
  break;
}
```

- [ ] **Step 4: 更新 `dungeon.test.ts`**

移除 `nextRunNumber` 測試（改成 `countLogRuns` 是內部函式，不直接測），補充 `renameLogAfterSettle` 測試：

```typescript
describe("renameLogAfterSettle", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-settle-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("結算後 log.md rename 成 log-run-1.md", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-25", protagonistSummary: "沈奕", goal: "測試", secretsText: "真相" });
    await renameLogAfterSettle(world, "U-001");
    const dir = path.join(world, "dungeons", "U-001");
    const files = await readdir(dir);
    expect(files).toContain("log-run-1.md");
    expect(files).not.toContain("log.md");
  });

  it("第二次進入後結算 → log-run-2.md", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-25", protagonistSummary: "沈奕", goal: "第一次", secretsText: "真相" });
    await renameLogAfterSettle(world, "U-001");
    await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-26", protagonistSummary: "沈奕", goal: "第二次", secretsText: "真相" });
    await renameLogAfterSettle(world, "U-001");
    const dir = path.join(world, "dungeons", "U-001");
    const files = await readdir(dir);
    expect(files).toContain("log-run-1.md");
    expect(files).toContain("log-run-2.md");
    expect(files).not.toContain("log.md");
  });

  it("log.md 不存在時靜默略過", async () => {
    await mkdir(path.join(world, "dungeons", "U-001"), { recursive: true });
    await expect(renameLogAfterSettle(world, "U-001")).resolves.toBeUndefined();
  });
});

// 更新 enterDungeon 的現有測試——第二次進入現在需要先 rename
it("第二次進入同一副本 → run-2，且不覆寫既有 secrets", async () => {
  await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-20", protagonistSummary: "沈奕（積分 50）", goal: "找到隱藏出口", secretsText: "原始真相" });
  await renameLogAfterSettle(world, "U-001");  // 結算第一次
  const active = await enterDungeon(world, { dungeonId: "U-001", today: "2026-06-21", protagonistSummary: "沈奕（積分 80）", goal: "終結副本", secretsText: "新真相（不該寫入）" });
  expect(active.runId).toBe("run-2");
  // 現在 log.md 是第二次的，log-run-1.md 是第一次的
  const log = await readFile(path.join(world, "dungeons", "U-001", "log.md"), "utf8");
  expect(log).toContain("run-2");
  const secrets = await readFile(path.join(world, "dungeons", "U-001", "secrets.md"), "utf8");
  expect(secrets).toContain("原始真相");
  expect(secrets).not.toContain("不該寫入");
});
```

- [ ] **Step 5: 執行相關測試**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/dungeon.test.ts src/engine/turn/index.test.ts
```

Expected: PASS

- [ ] **Step 6: 執行全套**

```bash
npx vitest run
```

Expected: 全套通過

- [ ] **Step 7: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/dungeon.ts app/src/engine/dungeon.test.ts app/src/engine/turn/index.ts
git commit -m "feat(engine): 結算後 log.md rename 成 log-run-N.md（每次進入獨立記錄）"
```

---

## Task 2：中文 ID 支援

**Interfaces:**
- `NPC_ID_RE` → 改為路徑穿越防護正則（允許 Unicode）
- `ITEM_ID_RE` → 同上
- `sanitizeTouchedEntities` 的 `HAS_ALNUM_RE` → 改為允許中文字視為合法字元
- `rewriteNpcFile`、`enterDungeon`：id 落地前 `toTraditional()`
- `prompts.ts`：移除 slug 要求，改為中文名稱建議

- [ ] **Step 1: 修改 `context.ts` — NPC_ID_RE 放寬**

```typescript
/**
 * 防止路徑穿越：NPC id 不可含路徑分隔符、null byte 或 ".."。
 * 允許中文顯示名稱（Unicode）；不可含 /、\、:、?、*、<、>、| 等危險字元。
 */
export const NPC_ID_RE = /^[^/\\:?*<>|"\x00]+$/;

/** 防止 ".." 路徑穿越 */
function isPathSafe(id: string): boolean {
  return NPC_ID_RE.test(id) && !id.includes("..");
}
```

修改 `rewriteNpcFile`：
```typescript
export async function rewriteNpcFile(
  worldDir: string,
  id: string,
  content: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  const safeId = toTraditional(id.trim());
  if (!isPathSafe(safeId) || safeId === "") {
    logger.warn({ id }, "touched_entities 含不合法 NPC id，略過");
    return;
  }
  // ... 其餘不變，把 id 換成 safeId
  const file = path.join(worldDir, "characters", `${safeId}.md`);
  await writeFile(file, `${safe.trim()}\n`, "utf8");
}
```

- [ ] **Step 2: 修改 `lore-rewrite.ts` — ITEM_ID_RE 放寬**

```typescript
/** 防止路徑穿越：id 不可含 /、\、..、null byte 等危險字元；允許中文顯示名稱 */
export const ITEM_ID_RE = /^[^/\\:?*<>|"\x00]+$/;
```

在 `rewriteLoreEntity` 等落地前（呼叫 `rewriteLoreWiki` 前），對 id 執行 `toTraditional()`：

找到 `lore-sync.ts` 裡呼叫 `rewriteLoreEntity` 傳入 id 的地方，確認 id 已繁體化（若 `rewriteLoreEntity` 直接轉發，就在那裡加 `toTraditional(e.id)` 的正規化）。

實際上 `rewriteLoreEntity` 在 `lore-rewrite.ts` 裡，找到它呼叫 `rewriteLoreWiki` 的地方：

```typescript
// 落地前繁體化 id（用作檔名）
const safeId = toTraditional(entity.id.trim());
await rewriteLoreWiki(deps.worldDir, category, safeId, newContent, title, log);
```

- [ ] **Step 3: 修改 `lore-sync-validate.ts` — 放寬 id 驗證**

```typescript
// 移除舊的 HAS_ALNUM_RE
// 改為：含至少一個非空白字元（中文字、英文字母、數字都算）
const HAS_CONTENT_RE = /\S/;

// sanitizeTouchedEntities 裡的驗證改為：
if (!ITEM_ID_RE.test(id) || !HAS_CONTENT_RE.test(id)) {
  log.warn({ entity: e }, "touched_entities id 含不合法路徑字元，略過");
  continue;
}
```

同時把 `ID_BLACKLIST` 加入繁體版本（已有 `"主神"`, `"系統"`, `"系统"`，確認簡繁都有）：

```typescript
const ID_BLACKLIST: ReadonlySet<string> = new Set([
  "system", "none", "unknown", "na", "n/a", "null", "undefined",
  "主神", "系統", "系统",
]);
```

注意：`sanitizeTouchedEntities` 裡已做 `id.trim().toLowerCase()`，中文字 toLowerCase 不影響，但繁體化需在此之後另外處理（或依賴呼叫端在落地前繁體化）。

- [ ] **Step 4: 修改 `dungeon.ts` — enterDungeon 繁體化 dungeonId**

在 `enterDungeon` 的 `dir` 計算前加：

```typescript
const safeDungeonId = toTraditional(params.dungeonId.trim());
// 之後全部用 safeDungeonId 取代 params.dungeonId（路徑、log 標題、secrets 標題）
```

- [ ] **Step 5: 修改 `prompts.ts` — 移除 slug 要求**

找到 `LORE_SYNC_FORMAT_BLOCK` 裡描述 `touched_entities.id` 的部分（約第 52–54 行）：

```typescript
// 舊版
"    category 只能是 npc/item/scene/skill 其中之一；id 用小寫英數 slug，單字以底線分隔（snake_case）；",
"    **id 必須是 name 的英文直譯**，例如「辨識震動」→ identify_vibration、「碰撞警報裝置」→ collision_alarm_device；" +
  "不可用系統視角的功能描述詞（如 system_monitor、handler、manager、detector）取代實體本身的名字；不可用中文、空白或純標點；name 用顯示名稱；",
```

改為：

```typescript
"    category 只能是 npc/item/scene/skill 其中之一；id 直接用中文顯示名稱（建議）或英文 slug；",
"    **id 必須對應實體本身的名字**（例如「關公」「碰撞警報裝置」），不可用系統視角功能詞（system_monitor、handler）取代；" +
  "id 不可含 /、\\、.. 等路徑字元；name 用顯示名稱；",
```

找到 `announced_dungeon` 的說明（約第 60 行）：

```typescript
// 舊版
"已進入過的副本或尚未公告的副本省略此欄。",
// （前面有）id 用小寫 kebab-case（如 u-001）

// 改為：
"id 直接用副本顯示名稱（如「魔獸世界」）；已進入過的副本或尚未公告的副本省略此欄。",
```

- [ ] **Step 6: 更新測試**

`lore-sync-validate.test.ts`：
- 把「非合法 slug」的測試案例改為「含路徑穿越字元」（`id: "evil/../path"`）
- 新增「中文 id 通過驗證」測試案例

`context.test.ts`（若有 NPC_ID_RE 相關測試）：
- 確認中文 id 通過，`../evil` 被擋

- [ ] **Step 7: 執行全套測試**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run && npx tsc --noEmit
```

Expected: 全套通過，tsc 零錯誤

- [ ] **Step 8: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/context.ts \
        app/src/engine/dungeon.ts \
        app/src/engine/turn/lore-rewrite.ts \
        app/src/engine/turn/lore-sync-validate.ts \
        app/src/engine/turn/prompts.ts \
        app/src/engine/turn/lore-sync-validate.test.ts \
        app/src/engine/context.test.ts
git commit -m "feat(engine): 開放 dungeonId/NPC id/entity id 使用中文顯示名稱"
```

---

## 自審 Checklist

**Spec 覆蓋：**
- [x] `enterDungeon` 改從計數 `log-run-*.md` 決定序號 — Task 1
- [x] 新增 `renameLogAfterSettle` — Task 1
- [x] `settle_dungeon` 呼叫 `renameLogAfterSettle` — Task 1
- [x] `NPC_ID_RE` / `ITEM_ID_RE` 放寬允許中文 — Task 2
- [x] 路徑穿越防護保留（`/`, `\`, `..`） — Task 2
- [x] `rewriteNpcFile` / `enterDungeon` 落地前 `toTraditional()` — Task 2
- [x] `prompts.ts` 移除 slug 要求 — Task 2

**Placeholder 掃描：** 無 TBD/TODO

**型別一致性：**
- `renameLogAfterSettle(worldDir, dungeonId, logger?)` 簽名一致
- `isPathSafe` 在 `context.ts` 內部使用，不 export
