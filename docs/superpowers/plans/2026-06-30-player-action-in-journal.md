# 玩家行動嵌入 Journal.md 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把玩家輸入從 `player-decisions.md` 移到 `journal.md`（每段 `> 玩家：行動` 緊接觸發的 `## heading`），骰池改為 HTML comment。

**Architecture:** 三步驟——(1) 更新 `JournalEntry`/`RunEntry`/`TurnPlan` 介面讓 append 函式接受 `playerAction`；(2) `turn-core.ts` 傳入 `playerAction: input` 並重組 body 格式；(3) 移除 `player-decisions` 模組與呼叫點。

**Tech Stack:** TypeScript、Node.js、Vitest（`cd app && npm test`）

## Global Constraints

- `playerAction` 非空才寫 `> 玩家：` 行；空字串（開場回合）跳過
- 骰池格式：`<!-- 骰池：[d1, d2, ...] -->`（HTML comment），永遠在最尾端（`建議動作` 之後）
- `parseLastTurnRecord` 須向下相容舊格式（`玩家行動：` 前綴）
- 刪除：`app/src/engine/player-decisions.ts`、`app/src/engine/player-decisions.test.ts`
- 測試指令：`cd app && npm test`，全套 pass（`npm run typecheck` 也無錯誤）
- Vitest 語法：`describe`/`it`/`expect`/`beforeEach`/`afterEach`

---

## 檔案異動總覽

| 檔案 | 動作 |
|------|------|
| `app/src/engine/journal.ts` | 修改：JournalEntry + appendJournal + parseLastTurnRecord |
| `app/src/engine/dungeon.ts` | 修改：RunEntry + appendLog |
| `app/src/engine/turn/types.ts` | 修改：TurnPlan.appendRaw 型別 |
| `app/src/engine/journal.test.ts` | 修改：新增 playerAction 與新格式解析測試 |
| `app/src/engine/turn/turn-core.ts` | 修改：body 格式 + 傳入 playerAction |
| `app/src/engine/turn/index.test.ts` | 修改：journal 新格式驗證 |
| `app/src/server/routes/turn.ts` | 修改：移除 appendPlayerDecision 呼叫與 import |
| `app/src/engine/player-decisions.ts` | 刪除 |
| `app/src/engine/player-decisions.test.ts` | 刪除 |
| `app/src/server/app.test.ts` | 修改：player-decisions 斷言改為 journal 斷言 |

---

## Task 1：core interfaces + append functions

**Files:**
- Modify: `app/src/engine/journal.ts`
- Modify: `app/src/engine/dungeon.ts`
- Modify: `app/src/engine/turn/types.ts`
- Test: `app/src/engine/journal.test.ts`

**Interfaces:**
- Produces:
  - `JournalEntry.playerAction?: string` — 供 appendJournal 使用
  - `RunEntry.playerAction?: string` — 供 appendLog 使用
  - `TurnPlan.appendRaw` 型別加入 `playerAction?`
  - `parseLastTurnRecord` 向下相容舊格式、正確去除 HTML comment

---

- [ ] **Step 1：寫失敗測試（journal.test.ts）**

在 `app/src/engine/journal.test.ts` 的 `describe("appendJournal")` 區塊末尾加入兩個新的 `it` 測試，並在 `describe("parseLastTurnRecord")` 末尾加入兩個新的 `it` 測試：

```typescript
// ---- appendJournal 新增 2 個 it ----

it("playerAction 非空時，> 玩家：行出現在 ## 段落標題之前", async () => {
  await appendJournal(dir, {
    date: "2026-06-19",
    title: "新回合",
    body: "沈奕做了某事。",
    playerAction: "去資訊室",
  });
  const md = await readFile(path.join(dir, "journal.md"), "utf8");
  expect(md).toContain("> 玩家：去資訊室");
  expect(md.indexOf("> 玩家：去資訊室")).toBeLessThan(
    md.indexOf("## [2026-06-19] 新回合"),
  );
});

it("playerAction 為空字串或未提供時，不寫入 > 玩家：行", async () => {
  await appendJournal(dir, {
    date: "2026-06-19",
    title: "新回合",
    body: "沈奕做了某事。",
    playerAction: "",
  });
  const md = await readFile(path.join(dir, "journal.md"), "utf8");
  expect(md).not.toContain("> 玩家：");
});

// ---- parseLastTurnRecord 新增 2 個 it ----

it("新格式：建議動作後的 HTML comment 骰池行不進 narrative 也不進 suggestedActions", () => {
  const md = [
    "## [2026-06-19] 新回合",
    "",
    "沈奕走進資訊室，葉晴抬頭看他。",
    "",
    "建議動作：詢問葉晴、離開",
    "<!-- 骰池：[66, 5, 26] -->",
    "",
  ].join("\n");

  const result = parseLastTurnRecord(md);
  expect(result).not.toBeNull();
  expect(result!.narrative).toBe("沈奕走進資訊室，葉晴抬頭看他。");
  expect(result!.suggestedActions).toEqual(["詢問葉晴", "離開"]);
  expect(result!.narrative).not.toContain("骰池");
});

it("新格式：無建議動作時，HTML comment 骰池行不殘留在 narrative", () => {
  const md = "## [2026-06-19] 新回合\n\n什麼都沒發生。\n<!-- 骰池：[10, 20] -->";
  const result = parseLastTurnRecord(md);
  expect(result).toEqual({ narrative: "什麼都沒發生。", suggestedActions: [] });
});
```

- [ ] **Step 2：確認新測試失敗**

```bash
cd app && npm test -- --reporter=verbose src/engine/journal.test.ts 2>&1 | grep -E "FAIL|PASS|playerAction|HTML|骰池|✓|×"
```

預期：4 個新測試 FAIL（`playerAction` 介面尚不存在）；現有測試 PASS。

- [ ] **Step 3：更新 journal.ts**

完整取代 `app/src/engine/journal.ts`：

```typescript
import { appendFile } from "node:fs/promises";
import path from "node:path";

export interface JournalEntry {
  date: string;
  title: string;
  body: string;
  playerAction?: string;
}

/**
 * 把一段回合記錄 append 到 world/journal.md（主空間 raw 層，append-only）。
 * 若有 playerAction，在 ## 段落前加入 > 玩家：行（同一次寫入，決定論）。
 */
export async function appendJournal(worldDir: string, entry: JournalEntry): Promise<void> {
  const playerLine = entry.playerAction?.trim()
    ? `\n> 玩家：${entry.playerAction.trim()}\n`
    : "";
  const section = `${playerLine}\n## [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`;
  await appendFile(path.join(worldDir, "journal.md"), section, "utf8");
}

export interface LastTurnRecord {
  narrative: string;
  suggestedActions: string[];
}

/**
 * 還原最後一段回合記錄（給前端重開頁面時還原劇情）。
 * 通用於 journal.md 與 dungeons/<id>/log.md（兩者段落格式相同）。
 */
export function parseLastTurnRecord(md: string): LastTurnRecord | null {
  const headers = [...md.matchAll(/^## \[.*?\] .*$/gm)];
  const last = headers.at(-1);
  if (!last || last.index === undefined) return null;

  let body = md.slice(last.index + last[0].length).trim();
  // 舊格式向下相容：去除 玩家行動：/骰池： 前綴
  body = body.replace(/^玩家行動：.*\n(骰池：.*\n)?\n*/, "");

  let suggestedActions: string[] = [];
  // m flag：$ 匹配行尾，不跨行，避免 HTML comment 進入 suggestedActions
  const suggestedMatch = body.match(/\n\n建議動作：(.+)$/m);
  if (suggestedMatch) {
    suggestedActions = suggestedMatch[1]
      .split("、")
      .map((s) => s.trim())
      .filter(Boolean);
    body = body.slice(0, suggestedMatch.index).trimEnd();
  }

  body = body.replace(/\n\n擲骰：.*$/s, "").trimEnd();
  // 新格式：去除尾端 HTML comment 骰池行（擲骰與建議動作均無時可能殘留）
  body = body.replace(/\n<!-- 骰池：[^\n]*-->/g, "").trimEnd();
  return { narrative: body, suggestedActions };
}
```

- [ ] **Step 4：更新 dungeon.ts（RunEntry + appendLog）**

在 `app/src/engine/dungeon.ts` 做兩處修改。

**4a. RunEntry 介面**（約 line 118）— 新增 `playerAction?`：

```typescript
export interface RunEntry {
  date: string;
  title: string;
  body: string;
  playerAction?: string;
}
```

**4b. appendLog 函式**（約 line 125）— 加入 playerLine 邏輯：

```typescript
/** 把回合記錄 append 到 dungeons/<id>/log.md（副本 raw 層，append-only） */
export async function appendLog(
  worldDir: string,
  dungeonId: string,
  runId: string,
  entry: RunEntry,
): Promise<void> {
  const file = path.join(dungeonDir(worldDir, dungeonId), "log.md");
  const playerLine = entry.playerAction?.trim()
    ? `\n> 玩家：${entry.playerAction.trim()}\n`
    : "";
  await appendFile(file, `${playerLine}\n## [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`, "utf8");
}
```

- [ ] **Step 5：更新 turn/types.ts（TurnPlan.appendRaw 型別）**

在 `app/src/engine/turn/types.ts` 找到 `appendRaw` 那行（約 line 83）：

```typescript
// 改前
appendRaw: (entry: { date: string; title: string; body: string }) => Promise<void>;

// 改後
appendRaw: (entry: { date: string; title: string; body: string; playerAction?: string }) => Promise<void>;
```

- [ ] **Step 6：型別檢查**

```bash
cd app && npm run typecheck 2>&1 | head -20
```

預期：無錯誤（`TurnPlan.appendRaw` 介面更新，index.ts 的實作傳 entry 到 appendJournal/appendLog，自動透傳 playerAction）。

- [ ] **Step 7：跑測試確認 Task 1 新測試通過**

```bash
cd app && npm test -- --reporter=verbose src/engine/journal.test.ts 2>&1 | grep -E "FAIL|PASS|✓|×"
```

預期：所有 `journal.test.ts` 測試 PASS（含舊格式向下相容的 4 個原測試 + 新增 4 個）。

- [ ] **Step 8：Commit Task 1**

```bash
git add app/src/engine/journal.ts app/src/engine/dungeon.ts app/src/engine/turn/types.ts app/src/engine/journal.test.ts
git commit -m "feat: JournalEntry/RunEntry 新增 playerAction，appendJournal/appendLog 寫入 > 玩家：行"
```

---

## Task 2：turn-core.ts body 格式改寫

**Files:**
- Modify: `app/src/engine/turn/turn-core.ts`
- Test: `app/src/engine/turn/index.test.ts`（驗證新 journal 格式）

**Interfaces:**
- Consumes: `TurnPlan.appendRaw` 含 `playerAction?`（Task 1 產生）
- Produces: journal.md 段落格式為 `> 玩家：input\n\n## heading\n\n narrative\n\n建議動作：...\n<!-- 骰池：[...] -->`

---

- [ ] **Step 1：寫失敗測試（index.test.ts）**

在 `app/src/engine/turn/index.test.ts` 找到約 line 160 的 `const journal = await readFile(...)` 區塊（它在 `it("主空間回合正常流程..."` 測試內）。找到現有：

```typescript
const journal = await readFile(path.join(world, "journal.md"), "utf8");
expect(journal).toContain("## [2026-06-19] 沈奕進資訊室");
expect(journal).toContain("去資訊室");
```

在這三行之後，立即新增：

```typescript
// 新格式驗證
expect(journal).toContain("> 玩家：去資訊室");
expect(journal).toContain("<!-- 骰池：[10, 20] -->");
expect(journal).not.toContain("玩家行動：");
expect(journal).not.toContain("骰池：[10, 20]\n"); // flat 骰池行不應存在
expect(journal.indexOf("> 玩家：去資訊室")).toBeLessThan(
  journal.indexOf("## [2026-06-19] 沈奕進資訊室"),
);
```

- [ ] **Step 2：確認新測試失敗**

```bash
cd app && npm test -- --reporter=verbose src/engine/turn/index.test.ts 2>&1 | grep -E "FAIL|PASS|玩家|骰池|✓|×" | head -20
```

預期：`> 玩家：去資訊室` 斷言 FAIL（目前 journal 寫的是 `玩家行動：去資訊室`）。

- [ ] **Step 3：修改 turn-core.ts**

在 `app/src/engine/turn/turn-core.ts` 找到約 line 117–128 的 raw 層寫入段落：

```typescript
// 改前（約 line 117–128）
// 1. raw 層
const rollsLine =
  control && control.rolls.length > 0
    ? `\n\n擲骰：${control.rolls.map((r) => `${r.desc}=${r.value}${r.success === undefined ? "" : r.success ? "(成功)" : "(失敗)"}`).join("、")}`
    : "";
const suggestedActions = control?.suggested_actions ?? [];
const suggestedLine = suggestedActions.length > 0 ? `\n\n建議動作：${suggestedActions.join("、")}` : "";
await plan.appendRaw({
  date: today,
  title: summary,
  body: `玩家行動：${input}\n骰池：[${dicePool.join(", ")}]\n\n${narrative}${rollsLine}${suggestedLine}`,
});
```

取代為：

```typescript
// 1. raw 層
const rollsLine =
  control && control.rolls.length > 0
    ? `\n\n擲骰：${control.rolls.map((r) => `${r.desc}=${r.value}${r.success === undefined ? "" : r.success ? "(成功)" : "(失敗)"}`).join("、")}`
    : "";
const suggestedActions = control?.suggested_actions ?? [];
const suggestedLine = suggestedActions.length > 0 ? `\n\n建議動作：${suggestedActions.join("、")}` : "";
const diceComment = `\n<!-- 骰池：[${dicePool.join(", ")}] -->`;
await plan.appendRaw({
  date: today,
  title: summary,
  playerAction: input,
  body: `${narrative}${rollsLine}${suggestedLine}${diceComment}`,
});
```

- [ ] **Step 4：型別檢查**

```bash
cd app && npm run typecheck 2>&1 | head -20
```

預期：無錯誤。

- [ ] **Step 5：跑測試確認 Task 2 通過**

```bash
cd app && npm test -- --reporter=verbose src/engine/turn/index.test.ts 2>&1 | grep -E "FAIL|PASS|✓|×" | head -30
```

預期：所有測試 PASS，包含新增的 5 個 journal 格式斷言。

- [ ] **Step 6：跑全套測試**

```bash
cd app && npm test 2>&1 | tail -10
```

預期：所有測試 PASS。

- [ ] **Step 7：Commit Task 2**

```bash
git add app/src/engine/turn/turn-core.ts app/src/engine/turn/index.test.ts
git commit -m "feat: journal body 格式改為 > 玩家：行 + <!-- 骰池 --> comment，移除 flat 玩家行動/骰池前綴"
```

---

## Task 3：移除 player-decisions 系統

**Files:**
- Modify: `app/src/server/routes/turn.ts`（移除 appendPlayerDecision 呼叫與 import）
- Delete: `app/src/engine/player-decisions.ts`
- Delete: `app/src/engine/player-decisions.test.ts`
- Modify: `app/src/server/app.test.ts`（player-decisions 斷言改為 journal 斷言）

**Interfaces:**
- Consumes: 無（純清除）
- Produces: player-decisions 模組消失，turn.ts 不再寫入 `world/player-decisions.md`

---

- [ ] **Step 1：更新 app.test.ts**

在 `app/src/server/app.test.ts` 找到約 line 622 的 `describe("POST /api/turn 玩家決策記錄", ...)` 區塊：

```typescript
// 改前（整個 describe 區塊，約 line 622–658）
describe("POST /api/turn 玩家決策記錄", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-turn-decision-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 設定\n禁止竄改數值。\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 進行中的副本：無\n- 最後更新：[2026-06-18] 舊\n",
    );
    await writeFile(
      path.join(world, "characters", "protagonist.md"),
      "- 姓名：沈奕\n- 當前積分：0\n",
    );
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("POST /api/turn 會在主回合開始前記錄玩家原始輸入", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["前半段，", "後半段。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "確認出口",
        }),
      ]),
      commit: async () => true,
    });
    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "先確認出口" } });
    expect(res.statusCode).toBe(200);
    const decisionsContent = await readFile(path.join(world, "player-decisions.md"), "utf8");
    expect(decisionsContent).toContain("先確認出口");
    await server.close();
  });
});
```

取代為：

```typescript
describe("POST /api/turn 玩家輸入寫入 journal.md", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-turn-decision-"));
    await mkdir(path.join(world, "characters"), { recursive: true });
    await writeFile(path.join(world, "setting.md"), "# 設定\n禁止竄改數值。\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 進行中的副本：無\n- 最後更新：[2026-06-18] 舊\n",
    );
    await writeFile(
      path.join(world, "characters", "protagonist.md"),
      "- 姓名：沈奕\n- 當前積分：0\n",
    );
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("POST /api/turn 回合後 journal.md 包含 > 玩家：行", async () => {
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["前半段，", "後半段。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "確認出口",
        }),
      ]),
      commit: async () => true,
    });
    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "先確認出口" } });
    expect(res.statusCode).toBe(200);
    const journalContent = await readFile(path.join(world, "journal.md"), "utf8");
    expect(journalContent).toContain("> 玩家：先確認出口");
    await server.close();
  });
});
```

- [ ] **Step 2：修改 turn.ts — 移除 appendPlayerDecision**

在 `app/src/server/routes/turn.ts` 做兩處修改：

**2a. 移除 import**（約 line 27）：

```typescript
// 刪除這行
import { appendPlayerDecision } from "../../engine/player-decisions.js";
// 刪除這行
import { readPlayerMetaCounts } from "../../engine/player-meta.js";
```

**2b. 移除呼叫區塊**（約 line 182–199，整個 `{ ... }` 區塊）：

```typescript
// 刪除以下整個區塊（含前後空行中的一行）：
{
  const metaPlayerPath = path.join(repoRoot, "meta", "player.md");
  let protagonistGeneration = 1;
  if (existsSync(metaPlayerPath)) {
    try {
      const counts = await readPlayerMetaCounts(repoRoot);
      protagonistGeneration = counts.protagonistGenerationCount + 1;
    } catch {
      // player.md 格式異常時靜默降級
    }
  }
  await appendPlayerDecision(config.worldDir, {
    turnId,
    protagonistGeneration,
    createdAt: new Date().toISOString(),
    input,
  });
}
```

（保留上方的 `const stateData = await loadState(...)` 和下方的 `const turnDeps = {`，兩者中間只剩一個空行。）

注意：`existsSync` 在約 line 148 還有另一個使用點，**不能移除** `import { existsSync } from "node:fs";`。

- [ ] **Step 3：刪除 player-decisions 模組**

```bash
rm app/src/engine/player-decisions.ts app/src/engine/player-decisions.test.ts
```

- [ ] **Step 4：型別檢查**

```bash
cd app && npm run typecheck 2>&1 | head -20
```

預期：無錯誤（`readPlayerMetaCounts` import 已移除，`appendPlayerDecision` import 已移除）。

- [ ] **Step 5：跑全套測試**

```bash
cd app && npm test 2>&1 | tail -15
```

預期：全部 PASS，`player-decisions` 相關測試不再存在（已刪除）。

- [ ] **Step 6：Commit Task 3**

```bash
git add app/src/server/routes/turn.ts app/src/server/app.test.ts
git rm app/src/engine/player-decisions.ts app/src/engine/player-decisions.test.ts
git commit -m "refactor: 移除 player-decisions 模組，玩家輸入改由 journal.md > 玩家：行記錄"
```

---

## Self-Review

**1. Spec 覆蓋：**
- `JournalEntry.playerAction?` → Task 1 Step 3 ✓
- `appendJournal` 寫 `> 玩家：` 行 → Task 1 Step 3 ✓
- `RunEntry.playerAction?` / `appendLog` → Task 1 Step 4 ✓
- `TurnPlan.appendRaw` 型別 → Task 1 Step 5 ✓
- `parseLastTurnRecord` fix `m` flag + HTML comment strip → Task 1 Step 3 ✓
- `parseLastTurnRecord` 舊格式向下相容 → Task 1 Step 3（保留舊 replace regex）✓
- `turn-core.ts` body 格式改為新格式 → Task 2 Step 3 ✓
- `turn-core.ts` 傳入 `playerAction: input` → Task 2 Step 3 ✓
- 骰池 HTML comment 格式 → Task 2 Step 3 ✓
- 移除 `appendPlayerDecision` 呼叫 → Task 3 Step 2 ✓
- 刪除 `player-decisions.ts` / `.test.ts` → Task 3 Step 3 ✓
- 更新 `app.test.ts` → Task 3 Step 1 ✓

**2. Placeholder 掃描：** 無。

**3. 型別一致性：**
- `playerAction?: string` 在 Task 1 定義，Task 2 使用 `playerAction: input`（`string`，相容）✓
- `diceComment` 型別為 `string`（template literal）✓
- `appendRaw` 型別更新後，index.ts 的 `(entry) => appendJournal(deps.worldDir, entry)` 透傳有效 ✓
