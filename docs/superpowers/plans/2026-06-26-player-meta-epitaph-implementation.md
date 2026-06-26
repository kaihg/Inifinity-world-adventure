# Player Meta Epitaph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add repo-level player meta tracking, per-generation epitaph archives, and minimal player decision provenance while keeping a single active `world/`.

**Architecture:** Keep `world/` as the only active runtime state and add a separate `meta/` layer for cross-world artifacts. Generate a stable `world_uuid` during `world/init`, store protagonist-generation artifacts under `meta/epitaphs/<epitaph-id>/`, and update `meta/player.md` only during protagonist/world settlement flows. Record explicit player inputs in a world-local provenance log so future epitaphs and traits can distinguish player decisions from narrative-only text.

**Tech Stack:** Node.js 20+, TypeScript, Fastify, Vitest, Markdown file storage under `world/`, `meta/`, and `archives/`.

## Global Constraints

- 全程繁體中文 + 台灣用詞，禁簡體習慣用詞（含 UI 文案、commit message）。
- 維持 **單一 active `world/`**；不做多世界並存與切換。
- 不做帳號、登入、多人隔離、資料庫。
- `meta/` 是 repo-level canonical 資料層，不跟著 `world/` 重置或封存而被清空。
- `meta/` 不回流影響 `world/init` 或新主角初始化。
- 不做 traits 分數、tag、開局 bonus/malus。
- 不做輪迴回顧 UI。
- `recall` 不讀 `meta/`。
- `world_uuid` 在 `world/init` 時生成一次，寫入 `world/setting.md`，並作為 archive / meta 的世界主索引。
- 每代主角的封存資產固定放在 `meta/epitaphs/<epitaph-id>/`，至少包含 `epitaph.md`、`journal.md`、`protagonist.md`。
- 主角換代或主角死亡後直接結束世界時，必須先完成主角結算，再做世界結算。
- player decision provenance 只需記錄**玩家明確輸入**；不再考慮 auto-advance 分流。

---

### Task 1: Add `world_uuid` To World Initialization And Archive Naming

**Files:**
- Create: `app/src/engine/world-id.ts`
- Modify: `app/src/engine/world-ops.ts`
- Modify: `app/src/engine/archive.ts`
- Modify: `app/src/engine/world-ops.test.ts`
- Test: `app/src/engine/world-ops.test.ts`
- Test: `app/src/engine/archive.test.ts`

**Interfaces:**
- Consumes: `initWorld(opts)`, `endWorld(opts)`, `archiveWorld(repoRoot, worldDir, now?)`
- Produces:
  - `generateWorldUuid(): string`
  - `injectWorldUuid(settingMd: string, worldUuid: string): string`
  - `readWorldUuid(worldDir: string): Promise<string>`
  - `archiveWorld(repoRoot: string, worldDir: string, worldUuid: string, now?: Date): Promise<string>`

- [ ] **Step 1: Write the failing tests for `world_uuid` generation and archive naming**

```ts
it("initWorld 會把 world_uuid 寫進 setting.md", async () => {
  await initWorld({ worldDir, repoRoot, client, input: {}, today: "2026-06-26", logger });
  const setting = await readFile(path.join(worldDir, "setting.md"), "utf8");
  expect(setting).toMatch(/世界 UUID[:：]\s*[a-f0-9-]{36}/i);
});

it("archiveWorld 以 world_uuid 組 archive 路徑", async () => {
  const rel = await archiveWorld(repoRoot, worldDir, "550e8400-e29b-41d4-a716-446655440000", new Date("2026-06-26T00:00:00Z"));
  expect(rel).toContain("550e8400-e29b-41d4-a716-446655440000");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- src/engine/world-ops.test.ts src/engine/archive.test.ts`

Expected: FAIL with missing `world_uuid` assertions and/or signature mismatch on `archiveWorld`.

- [ ] **Step 3: Add `world-id.ts` and minimal `setting.md` injection logic**

```ts
import { randomUUID } from "node:crypto";

export function generateWorldUuid(): string {
  return randomUUID();
}

export function injectWorldUuid(settingMd: string, worldUuid: string): string {
  if (/世界 UUID[:：]/.test(settingMd)) return settingMd;
  const lines = settingMd.trimEnd().split("\n");
  lines.splice(1, 0, "", `- 世界 UUID：${worldUuid}`);
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Thread `world_uuid` through `initWorld()` and `archiveWorld()`**

```ts
const worldUuid = generateWorldUuid();
const settingMdRaw = await generateText(client, settingMessages);
const settingMd = injectWorldUuid(settingMdRaw, worldUuid);
```

```ts
export async function archiveWorld(
  repoRoot: string,
  worldDir: string,
  worldUuid: string,
  now: Date = new Date(),
): Promise<string> {
  const relArchiveDir = path.join("archives", `${archiveTimestamp(now)}-${worldUuid}`);
  // copy worldDir -> relArchiveDir/world
}
```

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `npm test -- src/engine/world-ops.test.ts src/engine/archive.test.ts`

Expected: PASS for the new `world_uuid` assertions.

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/world-id.ts app/src/engine/world-ops.ts app/src/engine/archive.ts app/src/engine/world-ops.test.ts app/src/engine/archive.test.ts
git commit -m "feat(engine): add world uuid to init and archive"
```

### Task 2: Add Player Meta Storage And Epitaph Directory Primitives

**Files:**
- Create: `app/src/engine/player-meta.ts`
- Create: `app/src/engine/player-meta.test.ts`
- Modify: `app/src/engine/archive.ts`
- Test: `app/src/engine/player-meta.test.ts`

**Interfaces:**
- Consumes: `repoRoot`, `worldUuid`, `archiveRelPath`
- Produces:
  - `ensurePlayerMeta(repoRoot: string): Promise<void>`
  - `nextEpitaphId(today: string, protagonistGenerationCount: number): string`
  - `createEpitaphDir(repoRoot: string, epitaphId: string): Promise<string>`
  - `appendPlayerMetaIndex(repoRoot: string, entry: PlayerMetaIndexEntry): Promise<void>`
  - `incrementPlayerCounts(repoRoot: string, counts: { worldHistoryDelta?: number; protagonistGenerationDelta?: number }): Promise<void>`
  - `readPlayerMetaCounts(repoRoot: string): Promise<{ worldHistoryCount: number; protagonistGenerationCount: number }>`

- [ ] **Step 1: Write the failing tests for `meta/player.md` bootstrap and epitaph directory creation**

```ts
it("ensurePlayerMeta 會建立 meta/player.md 與 meta/epitaphs/", async () => {
  await ensurePlayerMeta(repoRoot);
  expect(await readFile(path.join(repoRoot, "meta", "player.md"), "utf8")).toContain("已封存世界數：0");
  expect(await stat(path.join(repoRoot, "meta", "epitaphs"))).toBeDefined();
});

it("appendPlayerMetaIndex 會新增墓誌銘索引列並更新計數", async () => {
  await ensurePlayerMeta(repoRoot);
  await incrementPlayerCounts(repoRoot, { protagonistGenerationDelta: 1, worldHistoryDelta: 1 });
  await appendPlayerMetaIndex(repoRoot, {
    epitaphId: "epi-20260626-001",
    worldUuid: "550e8400-e29b-41d4-a716-446655440000",
    protagonistGeneration: 1,
    protagonistName: "沈奕",
    endingType: "死亡",
    createdAt: "2026-06-26",
  });
  const md = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
  expect(md).toContain("已封存世界數：1");
  expect(md).toContain("| epi-20260626-001 | 550e8400-e29b-41d4-a716-446655440000 | 1 | 沈奕 | 死亡 | 2026-06-26 |");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- src/engine/player-meta.test.ts`

Expected: FAIL with missing module/functions.

- [ ] **Step 3: Implement `player-meta.ts` with deterministic Markdown helpers**

```ts
export interface PlayerMetaIndexEntry {
  epitaphId: string;
  worldUuid: string;
  protagonistGeneration: number;
  protagonistName: string;
  endingType: string;
  createdAt: string;
}

export async function ensurePlayerMeta(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "meta", "epitaphs"), { recursive: true });
  const playerPath = path.join(repoRoot, "meta", "player.md");
  if (!(await pathExists(playerPath))) {
    await writeFile(playerPath, INITIAL_PLAYER_MD, "utf8");
  }
}
```

- [ ] **Step 4: Implement count and index updates without rewriting unrelated sections**

```ts
export async function incrementPlayerCounts(repoRoot: string, counts: { worldHistoryDelta?: number; protagonistGenerationDelta?: number }): Promise<void> {
  const md = await readFile(playerPath(repoRoot), "utf8");
  const next = md
    .replace(/已封存世界數：(\d+)/, (_m, n) => `已封存世界數：${Number(n) + (counts.worldHistoryDelta ?? 0)}`)
    .replace(/已結算主角代數：(\d+)/, (_m, n) => `已結算主角代數：${Number(n) + (counts.protagonistGenerationDelta ?? 0)}`);
  await writeFile(playerPath(repoRoot), next, "utf8");
}
```

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `npm test -- src/engine/player-meta.test.ts`

Expected: PASS for bootstrap, count update, and index append.

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/player-meta.ts app/src/engine/player-meta.test.ts
git commit -m "feat(engine): add player meta storage primitives"
```

### Task 3: Add Player Decision Provenance Logging

**Files:**
- Create: `app/src/engine/player-decisions.ts`
- Create: `app/src/engine/player-decisions.test.ts`
- Modify: `app/src/server/app.ts`
- Modify: `app/src/server/app.test.ts`
- Test: `app/src/engine/player-decisions.test.ts`
- Test: `app/src/server/app.test.ts`

**Interfaces:**
- Consumes: `/api/turn` request body `{ input: string }`, active `worldDir`
- Produces:
  - `appendPlayerDecision(worldDir: string, entry: PlayerDecisionEntry): Promise<void>`
  - `readPlayerDecisions(worldDir: string): Promise<PlayerDecisionEntry[]>`
  - `PlayerDecisionEntry = { turnId: string; protagonistGeneration: number; createdAt: string; input: string }`

- [ ] **Step 1: Write the failing tests for decision logging**

```ts
it("appendPlayerDecision 會把玩家輸入 append 到 world/player-decisions.md", async () => {
  await appendPlayerDecision(worldDir, {
    turnId: "turn-1",
    protagonistGeneration: 2,
    createdAt: "2026-06-26T10:00:00Z",
    input: "觀察四周",
  });
  const md = await readFile(path.join(worldDir, "player-decisions.md"), "utf8");
  expect(md).toContain("turn-1");
  expect(md).toContain("主角代數：2");
  expect(md).toContain("觀察四周");
});

it("POST /api/turn 會在主回合開始前記錄玩家原始輸入", async () => {
  const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "先確認出口" } });
  expect(await readFile(path.join(world, "player-decisions.md"), "utf8")).toContain("先確認出口");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- src/engine/player-decisions.test.ts src/server/app.test.ts`

Expected: FAIL with missing file/log assertions.

- [ ] **Step 3: Implement `player-decisions.ts` as an append-only Markdown log**

```ts
export async function appendPlayerDecision(worldDir: string, entry: PlayerDecisionEntry): Promise<void> {
  const file = path.join(worldDir, "player-decisions.md");
  const block = [
    `## ${entry.turnId}`,
    `- 時間：${entry.createdAt}`,
    `- 主角代數：${entry.protagonistGeneration}`,
    `- 玩家輸入：${entry.input}`,
    "",
  ].join("\n");
  await appendFile(file, (await pathExists(file)) ? block : `# 玩家決策記錄\n\n${block}`, "utf8");
}
```

- [ ] **Step 4: Call `appendPlayerDecision()` from `/api/turn` before LLM generation**

```ts
const { protagonistGenerationCount } = await readPlayerMetaCounts(repoRoot);
await appendPlayerDecision(config.worldDir, {
  turnId,
  protagonistGeneration: protagonistGenerationCount + 1,
  createdAt: new Date().toISOString(),
  input,
});
```

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `npm test -- src/engine/player-decisions.test.ts src/server/app.test.ts`

Expected: PASS for decision log persistence and route integration.

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/player-decisions.ts app/src/engine/player-decisions.test.ts app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(engine): add player decision provenance log"
```

### Task 4: Integrate Protagonist Settlement, Epitaph Archive, And Count Updates

**Files:**
- Create: `app/src/engine/protagonist-epitaph.ts`
- Create: `app/src/engine/protagonist-epitaph.test.ts`
- Modify: `app/src/engine/world-ops.ts`
- Modify: `app/src/engine/world-ops.test.ts`
- Modify: `app/src/server/app.ts`
- Modify: `app/src/server/app.test.ts`
- Test: `app/src/engine/protagonist-epitaph.test.ts`
- Test: `app/src/engine/world-ops.test.ts`
- Test: `app/src/server/app.test.ts`

**Interfaces:**
- Consumes:
  - `replaceProtagonist(opts)`
  - `endWorld(opts)`
  - `readWorldUuid(worldDir)`
  - `ensurePlayerMeta(repoRoot)`
  - `incrementPlayerCounts(...)`
  - `readPlayerMetaCounts(repoRoot)`
  - `appendPlayerMetaIndex(...)`
- Produces:
  - `settleProtagonist(opts: SettleProtagonistOpts): Promise<{ epitaphId: string; epitaphDir: string }>`
  - `SettleProtagonistOpts = { repoRoot: string; worldDir: string; client: LlmClient; logger: Logger; today: string; endingType: "死亡" | "主動封存" | "隨世界結束"; protagonistGeneration: number }`

- [ ] **Step 1: Write the failing tests for protagonist settlement artifacts**

```ts
it("settleProtagonist 會建立 epitaph 目錄並封存 journal/protagonist", async () => {
  const result = await settleProtagonist({
    repoRoot, worldDir, client: fakeClient, logger, today: "2026-06-26",
    endingType: "死亡", protagonistGeneration: 1,
  });
  expect(await readFile(path.join(result.epitaphDir, "journal.md"), "utf8")).toContain("舊日誌");
  expect(await readFile(path.join(result.epitaphDir, "protagonist.md"), "utf8")).toContain("沈奕");
  expect(await readFile(path.join(result.epitaphDir, "epitaph.md"), "utf8")).toContain("主神評語");
});

it("replaceProtagonist 會先做主角結算，再重置 active protagonist/journal", async () => {
  const archivedTo = await replaceProtagonist({ repoRoot, worldDir, client, protagonistSeed: {}, today: "2026-06-26", logger });
  const playerMd = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
  expect(playerMd).toContain("已結算主角代數：1");
  expect(playerMd).toContain("| epi-");
  expect(await readFile(path.join(worldDir, "journal.md"), "utf8")).toContain("新主角接替");
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `npm test -- src/engine/protagonist-epitaph.test.ts src/engine/world-ops.test.ts src/server/app.test.ts`

Expected: FAIL with missing settlement helper and no `meta/` updates.

- [ ] **Step 3: Implement `protagonist-epitaph.ts` to generate and persist `epitaph.md`**

```ts
export async function settleProtagonist(opts: SettleProtagonistOpts): Promise<{ epitaphId: string; epitaphDir: string }> {
  await ensurePlayerMeta(opts.repoRoot);
  const worldUuid = await readWorldUuid(opts.worldDir);
  const epitaphId = nextEpitaphId(opts.today, opts.protagonistGeneration);
  const epitaphDir = await createEpitaphDir(opts.repoRoot, epitaphId);
  await copyFile(path.join(opts.worldDir, "journal.md"), path.join(epitaphDir, "journal.md"));
  await copyFile(path.join(opts.worldDir, "characters", "protagonist.md"), path.join(epitaphDir, "protagonist.md"));
  const epitaphText = await generateText(opts.client, epitaphMessages);
  await writeFile(path.join(epitaphDir, "epitaph.md"), renderEpitaphMd({ epitaphId, worldUuid, ... }), "utf8");
  await incrementPlayerCounts(opts.repoRoot, { protagonistGenerationDelta: 1 });
  await appendPlayerMetaIndex(opts.repoRoot, { epitaphId, worldUuid, protagonistGeneration: opts.protagonistGeneration, ... });
  return { epitaphId, epitaphDir };
}
```

- [ ] **Step 4: Wire protagonist settlement into `replaceProtagonist()` and `endWorld()`**

```ts
await settleProtagonist({
  repoRoot,
  worldDir,
  client,
  logger,
  today,
  endingType: body.choice === "end-world" ? "隨世界結束" : "死亡",
  protagonistGeneration: (await readPlayerMetaCounts(repoRoot)).protagonistGenerationCount + 1,
});
```

```ts
const worldUuid = await readWorldUuid(worldDir);
const archivedTo = await archiveWorld(repoRoot, worldDir, worldUuid);
await incrementPlayerCounts(repoRoot, { worldHistoryDelta: 1 });
```

- [ ] **Step 5: Run the focused tests to verify they pass**

Run: `npm test -- src/engine/protagonist-epitaph.test.ts src/engine/world-ops.test.ts src/server/app.test.ts`

Expected: PASS for epitaph directory creation, player count updates, and keep-world/end-world route behavior.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`

Expected: PASS for all relevant new tests; if the existing `/api/world/init` failures remain on this branch, note that they predate this feature and are unrelated to the changed files before proceeding.

- [ ] **Step 7: Commit**

```bash
git add app/src/engine/protagonist-epitaph.ts app/src/engine/protagonist-epitaph.test.ts app/src/engine/world-ops.ts app/src/engine/world-ops.test.ts app/src/server/app.ts app/src/server/app.test.ts app/src/engine/player-meta.ts app/src/engine/player-decisions.ts app/src/engine/archive.ts
git commit -m "feat(engine): add player meta epitaph settlement flow"
```

## Self-Review

- **Spec coverage:** Task 1 covers `world_uuid`; Task 2 covers `meta/player.md` and `meta/epitaphs/` primitives; Task 3 covers player decision provenance; Task 4 covers protagonist settlement ordering, journal/protagonist snapshots, and world/protagonist count updates.
- **Placeholder scan:** No `TODO`/`TBD` placeholders remain; each task has concrete files, tests, commands, and target interfaces.
- **Type consistency:** `worldUuid`, `epitaphId`, `protagonistGeneration`, and player count names are consistent across all tasks.

Plan complete and saved to `docs/superpowers/plans/2026-06-26-player-meta-epitaph-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
