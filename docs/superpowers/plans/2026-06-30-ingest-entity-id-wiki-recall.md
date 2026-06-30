# Ingest Entity ID 正規化 + Wiki 注入 + Recall 查詢優化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 ingest 管線的 entity ID 全面正規化為中文名稱，category wiki 注入 Layer 1 prompt 作為名稱登記冊，recall 改用上一回合敘事作查詢源以提升精準度。

**Architecture:** 新增 `sanitizeLoreId()` 函式作為所有 lore ID 接觸 filesystem 的守門員；在 turn/index.ts 每回合讀取四個 category wiki 合為 `wikiBlock` 注入 Layer 1；recall 查詢從玩家短句改為上一回合完整敘事段落拼接玩家輸入。

**Tech Stack:** TypeScript、Vitest、Node.js fs/promises、Zod

## Global Constraints

- TypeScript strict mode；所有 export function 須有明確型別
- 測試框架：Vitest（`npm run test` in `app/`）
- 所有中文字串使用繁體中文
- ENOENT 靜默降級（不 throw），其他 I/O 錯誤記 warn
- 不改變 `RECALL_ENABLED` 開關行為，只改查詢源
- 現有舊 ID 檔案（英文 kebab-case）不做遷移

---

### Task 1：`sanitizeLoreId()` + 套用到 lore.ts 讀寫入口

**Files:**
- Modify: `app/src/engine/lore.ts`
- Modify: `app/src/engine/lore.test.ts`

**Interfaces:**
- Produces: `export function sanitizeLoreId(id: string): string`（被 Task 2 的 routes/turn.ts 引用）

- [ ] **Step 1：在 lore.test.ts 寫 sanitizeLoreId 的失敗測試**

```typescript
// 在 lore.test.ts 新增 describe block（放在最上方 import 後現有 describe 之前）
import { loreFilePath, loadLoreFile, rewriteLoreFile, listLoreIds, sanitizeLoreId } from "./lore.js";

describe("sanitizeLoreId", () => {
  it("trim 頭尾空白", () => {
    expect(sanitizeLoreId("  生化危機  ")).toBe("生化危機");
  });
  it("toLowerCase（中文無副作用，英文統一小寫）", () => {
    expect(sanitizeLoreId("Raccoon City")).toBe("raccoon city");
    expect(sanitizeLoreId("主神空間")).toBe("主神空間");
  });
  it("ASCII 冒號 → 全形冒號", () => {
    expect(sanitizeLoreId("生化危機:浣熊市")).toBe("生化危機：浣熊市");
  });
  it("ASCII 斜線 → 全形斜線", () => {
    expect(sanitizeLoreId("a/b\\c")).toBe("a／b／c");
  });
  it("截斷至 80 字元", () => {
    expect(sanitizeLoreId("a".repeat(100))).toHaveLength(80);
  });
  it("已是正規化 id 不變", () => {
    expect(sanitizeLoreId("基礎戰術反應")).toBe("基礎戰術反應");
  });
});
```

- [ ] **Step 2：執行測試確認 FAIL**

```bash
cd app && npx vitest run src/engine/lore.test.ts
```

Expected: FAIL with "sanitizeLoreId is not a function"

- [ ] **Step 3：在 lore.ts 實作 `sanitizeLoreId` 並套用到讀寫入口**

在 `lore.ts` 最上方（`export type LoreCategory` 之前）新增：

```typescript
/** 正規化 lore entity ID：統一小寫、全形化危險字元、截斷至 80 字元 */
export function sanitizeLoreId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/:/g, "：")
    .replace(/[/\\]/g, "／")
    .slice(0, 80);
}
```

修改 `loadLoreFile`，在第一行加 `const safeId = sanitizeLoreId(id);`，並把後續所有 `id` 改為 `safeId`：

```typescript
export async function loadLoreFile(
  worldDir: string,
  category: LoreCategory,
  id: string,
  logger: Logger = defaultLogger,
): Promise<string> {
  const safeId = sanitizeLoreId(id);
  const file = loreFilePath(worldDir, category, safeId);
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    logUnexpectedReadError(logger, file, err);
    return "";
  }
}
```

修改 `rewriteLoreFile`，同樣在第一行加 `const safeId = sanitizeLoreId(id);`，並把後續所有 `id` 改為 `safeId`：

```typescript
export async function rewriteLoreFile(
  worldDir: string,
  category: LoreCategory,
  id: string,
  content: string,
  title: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  const safeId = sanitizeLoreId(id);
  logger.debug({ category, id: safeId }, "整檔重寫 entity .md");
  const file = loreFilePath(worldDir, category, safeId);
  await mkdir(path.dirname(file), { recursive: true });
  const body = content.trim();
  const finalContent = /^#\s/.test(body) ? `${body}\n` : `# ${title}\n\n${body}\n`;
  await writeFile(file, finalContent, "utf8");
}
```

- [ ] **Step 4：執行測試確認 PASS**

```bash
cd app && npx vitest run src/engine/lore.test.ts
```

Expected: 所有測試 PASS

- [ ] **Step 5：Commit**

```bash
git add app/src/engine/lore.ts app/src/engine/lore.test.ts
git commit -m "feat: sanitizeLoreId() + 套用到 loadLoreFile/rewriteLoreFile 入口"
```

---

### Task 2：`transitionDungeonId` 正規化 + schema 描述更新

**Files:**
- Modify: `app/src/engine/schema.ts`
- Modify: `app/src/server/routes/turn.ts`

**Interfaces:**
- Consumes: `sanitizeLoreId` from `app/src/engine/lore.ts`（Task 1 產出）

- [ ] **Step 1：更新 schema.ts 中 transition_dungeon_id 的描述**

在 `app/src/engine/turn/prompts.ts` 的 `FAST_CONTROL_FORMAT_BLOCK` 找到：

```typescript
"- transition_dungeon_id / transition_dungeon_goal：配合 enter_dungeon 才填",
```

改為：

```typescript
"- transition_dungeon_id：配合 enter_dungeon 才填，使用副本的中文正式名稱（如「生化危機：浣熊市」）",
"- transition_dungeon_goal：配合 enter_dungeon 才填，描述本次進入目標",
```

- [ ] **Step 2：在 routes/turn.ts 對 transitionDungeonId 套用 sanitizeLoreId**

在 `app/src/server/routes/turn.ts` 頂部 import 新增：

```typescript
import { sanitizeLoreId } from "../../engine/lore.js";
```

找到判斷 `enter_dungeon` 的段落（約 line 258）：

```typescript
if (done.modeTransition === "enter_dungeon" && done.transitionDungeonId && stateData.mode !== "dungeon") {
```

在其進入 block 的第一行新增：

```typescript
const rawDungeonId = done.transitionDungeonId;
const safeDungeonId = sanitizeLoreId(rawDungeonId);
```

並把後續所有 `done.transitionDungeonId` 替換為 `safeDungeonId`。共有以下位置：
- `generateSecrets(makeClient(turnLogger), settingText, done.transitionDungeonId)` → `generateSecrets(makeClient(turnLogger), settingText, safeDungeonId)`
- `enterDungeon(config.worldDir, { dungeonId: done.transitionDungeonId, ... })` → `dungeonId: safeDungeonId`
- log/commit message 中的 `done.transitionDungeonId` → `safeDungeonId`

- [ ] **Step 3：執行全套測試確認無破壞**

```bash
cd app && npx vitest run
```

Expected: 全部 PASS

- [ ] **Step 4：Commit**

```bash
git add app/src/engine/turn/prompts.ts app/src/server/routes/turn.ts
git commit -m "feat: transitionDungeonId 入口套用 sanitizeLoreId，schema 描述改為中文名稱"
```

---

### Task 3：Extraction prompt 三條規則 + wiki format hint 改版

**Files:**
- Modify: `app/src/engine/ingest.ts`
- Modify: `app/src/engine/ingest.test.ts`

**Interfaces:**
- 無外部依賴，自包含的 prompt 字串變更

- [ ] **Step 1：更新 ingest.test.ts - 新增 extraction prompt 規則測試**

在 `app/src/engine/ingest.test.ts` 中找到 `extractEntities` 相關 describe block，新增測試驗證規則：

```typescript
it("extraction system prompt 包含中文 id 規則", async () => {
  // 攔截 client.streamChat，確認 system message 含有必要規則
  let capturedSystem = "";
  const mockClient: LlmClient = {
    streamChat: async function* (msgs) {
      capturedSystem = (msgs[0] as { role: string; content: string }).content;
      yield '{"protagonist_changed":false,"entities":[]}';
    },
    complete: async () => "",
  };
  await extractEntities(mockClient, "測試敘事", "", {}, { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} } as unknown as Logger);
  expect(capturedSystem).toContain("中文正式名稱");
  expect(capturedSystem).toContain("同一物理地點只能有一個 scene entity");
});
```

- [ ] **Step 2：執行測試確認 FAIL**

```bash
cd app && npx vitest run src/engine/ingest.test.ts
```

Expected: FAIL（現有 prompt 不含「中文正式名稱」）

- [ ] **Step 3：更新 extraction prompt 規則**

在 `app/src/engine/ingest.ts` 的 `extractEntities` system prompt 的規則清單（`"規則："` 之後）末尾新增三條：

```typescript
"- 所有 entity id 直接使用中文正式名稱，不做英文翻譯或 snake_case 轉換（例如「主神空間」而非 main_space）",
"- scene 的 id 使用場所的中文正式名稱；同一物理地點只能有一個 scene entity，禁止為同一場所的不同面向建立多個 id",
"- dungeon 的 id 使用副本的中文正式名稱（例如「生化危機：浣熊市」）",
```

- [ ] **Step 4：更新 `WIKI_FORMAT_HINT`**

在 `app/src/engine/ingest.ts` 找到 `WIKI_FORMAT_HINT` 常數，整段替換：

```typescript
const WIKI_FORMAT_HINT: Record<LoreCategory, string> = {
  skills: "分「主動技能」「被動技能」兩大段，各技能一行 `- [[id]]：一句中性描述`（不寫持有者或取得狀態）",
  items:  "分「消耗品」「持久道具」兩大段，各道具一行 `- [[id]]：品質等級、一句中性描述`",
  scenes: "分「主空間場景」「副本場景（副本名）」兩大段，各場景一行 `- [[id]]：環境基調`",
  dungeons: "各副本一行 `- [[id]]：難度基調、狀態（進行中/已結算）`",
};
```

- [ ] **Step 5：執行測試確認 PASS**

```bash
cd app && npx vitest run src/engine/ingest.test.ts
```

Expected: 所有測試 PASS

- [ ] **Step 6：Commit**

```bash
git add app/src/engine/ingest.ts app/src/engine/ingest.test.ts
git commit -m "feat: extraction prompt 中文 id 規則 + wiki format hint 改為名稱登記冊格式"
```

---

### Task 4：Category wiki 注入 Layer 1 prompt

**Files:**
- Modify: `app/src/engine/turn/index.ts`
- Modify: `app/src/engine/turn/prompts.ts`
- Modify: `app/src/engine/turn/prompts.test.ts`

**Interfaces:**
- Consumes: `readFile` from `node:fs/promises`、`path` 模組（已有）
- Produces: `BuildMessagesParams` 新增 `wikiBlock?: string` 欄位（被 turn/index.ts 使用）

- [ ] **Step 1：在 prompts.test.ts 寫 wikiBlock 注入的失敗測試**

在 `app/src/engine/turn/prompts.test.ts` 找到 `buildMainSpaceMessages` 測試，新增測試：

```typescript
it("wikiBlock 非空時注入 system prompt", () => {
  const msgs = buildMainSpaceMessages({
    settingText: "設定",
    state: mockState,
    input: "行動",
    dicePool: [50],
    wikiBlock: "## 已知實體索引\n### 技能\n- [[基礎戰術反應]]：強化戰術的 E 級技能",
  });
  expect(msgs[0].content).toContain("已知實體索引");
  expect(msgs[0].content).toContain("基礎戰術反應");
});

it("wikiBlock 為空時不注入", () => {
  const msgs = buildMainSpaceMessages({
    settingText: "設定",
    state: mockState,
    input: "行動",
    dicePool: [50],
  });
  expect(msgs[0].content).not.toContain("已知實體索引");
});
```

同理為 `buildDungeonMessages` 新增相同兩個測試。

- [ ] **Step 2：執行測試確認 FAIL**

```bash
cd app && npx vitest run src/engine/turn/prompts.test.ts
```

Expected: FAIL（`BuildMessagesParams` 無 `wikiBlock`）

- [ ] **Step 3：更新 `BuildMessagesParams` 並在 prompts.ts 加入 wikiBlock**

在 `app/src/engine/turn/prompts.ts` 找到 `BuildMessagesParams` interface，新增欄位：

```typescript
export interface BuildMessagesParams {
  settingText: string;
  state: GameState;
  input: string;
  dicePool: number[];
  intentsBlock?: string;
  recallBlock?: string;
  wikiBlock?: string;   // ← 新增
  nudgeBlock?: string;
  pacingBlock?: string;
  openingPrompt?: string;
}
```

在 `appendOptionalBlocks` 函式的 params 型別和 return 陣列新增 `wikiBlock`：

```typescript
function appendOptionalBlocks(params: {
  intentsBlock?: string;
  recallBlock?: string;
  wikiBlock?: string;   // ← 新增
  nudgeBlock?: string;
  pacingBlock?: string;
}): string[] {
  return [
    ...(params.intentsBlock ? ["", params.intentsBlock] : []),
    ...(params.wikiBlock ? ["", params.wikiBlock] : []),  // ← 新增（在 recallBlock 之前）
    ...(params.recallBlock ? ["", params.recallBlock] : []),
    ...(params.nudgeBlock ? ["", params.nudgeBlock] : []),
    ...(params.pacingBlock ? ["", params.pacingBlock] : []),
  ];
}
```

`buildDungeonMessages` 同樣把 `wikiBlock` 傳入 `appendOptionalBlocks`：

```typescript
// 現有 BuildDungeonMessagesParams 不需另外新增 wikiBlock（繼承自 BuildMessagesParams）
// appendOptionalBlocks(params) 呼叫不需改（params 本身就包含 wikiBlock）
```

- [ ] **Step 4：在 turn/index.ts 讀取 category wiki 並傳入**

在 `app/src/engine/turn/index.ts` 頂部 import 區新增：

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
```

（若已有則跳過）

在 `index.ts` 中任一 turn handler 之前，新增以下 helper 函式：

```typescript
/** 讀取四個 category wiki，合為一個名稱登記冊區塊；任一 wiki 不存在則略過 */
async function loadCategoryWikiBlock(worldDir: string): Promise<string> {
  const categories: Array<{ label: string; dir: string }> = [
    { label: "技能", dir: "skills" },
    { label: "道具", dir: "items" },
    { label: "場景", dir: "scenes" },
    { label: "副本", dir: "dungeons" },
  ];
  const parts: string[] = [];
  for (const { label, dir } of categories) {
    try {
      const content = await readFile(path.join(worldDir, dir, "wiki.md"), "utf8");
      if (content.trim()) parts.push(`### ${label}`, content.trim());
    } catch {
      // ENOENT 靜默略過
    }
  }
  if (parts.length === 0) return "";
  return ["## 已知實體索引（name registry）", ...parts].join("\n");
}
```

在主空間回合 handler（`runMainSpaceTurn`）中，在 `const recallBlock = ...` 之前新增：

```typescript
const wikiBlock = await loadCategoryWikiBlock(deps.worldDir);
```

並把 `wikiBlock` 傳入 `buildMainSpaceMessages`：

```typescript
messages: buildMainSpaceMessages({ settingText, state, input, dicePool, intentsBlock, recallBlock, wikiBlock, nudgeBlock, pacingBlock, openingPrompt }),
```

在副本回合 handler（`runDungeonTurn`）中同樣加入：

```typescript
const wikiBlock = await loadCategoryWikiBlock(deps.worldDir);
```

並傳入 `buildDungeonMessages`：

```typescript
intentsBlock, recallBlock, wikiBlock, nudgeBlock, pacingBlock,
```

- [ ] **Step 5：執行所有測試確認 PASS**

```bash
cd app && npx vitest run
```

Expected: 所有測試 PASS

- [ ] **Step 6：Commit**

```bash
git add app/src/engine/turn/index.ts app/src/engine/turn/prompts.ts app/src/engine/turn/prompts.test.ts
git commit -m "feat: category wiki 每回合注入 Layer 1 prompt 作為名稱登記冊"
```

---

### Task 5：Recall 查詢源改為上一回合敘事 + 玩家輸入

**Files:**
- Modify: `app/src/engine/turn/context-blocks.ts`
- Create: `app/src/engine/turn/context-blocks.test.ts`
- Modify: `app/src/engine/turn/index.ts`

**Interfaces:**
- Consumes: `state.lastTurn?.narrative` from `GameState.lastTurn`（`LastTurnRecord.narrative: string`，定義在 `engine/journal.ts`）
- Produces: `runRecallBlock(deps, input, lastNarrative?)` — 新增可選第三參數

- [ ] **Step 1：建立 context-blocks.test.ts 並寫失敗測試**

建立 `app/src/engine/turn/context-blocks.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { runRecallBlock } from "./context-blocks.js";
import type { TurnDeps } from "./types.js";

function makeDeps(queryCapture: { value: string }): Partial<TurnDeps> {
  return {
    recall: {
      query: async (q: string) => {
        queryCapture.value = q;
        return [];
      },
      upsertFile: async () => {},
    } as unknown as TurnDeps["recall"],
    recallTopK: 3,
  };
}

describe("runRecallBlock", () => {
  it("無 recall 時回空字串", async () => {
    const gen = runRecallBlock({ recall: undefined } as unknown as TurnDeps, "行動");
    const result = await gen.next();
    expect(result.value).toBe("");
  });

  it("有 lastNarrative 時查詢源為 lastNarrative + input 的組合", async () => {
    const capture = { value: "" };
    const deps = makeDeps(capture);
    const gen = runRecallBlock(
      deps as unknown as TurnDeps,
      "我向前走",
      "林逸站在主神空間中央，幾何晶體緩緩旋轉。",
    );
    // drain generator
    let done = false;
    while (!done) { done = (await gen.next()).done ?? false; }
    expect(capture.value).toContain("林逸站在主神空間");
    expect(capture.value).toContain("我向前走");
  });

  it("無 lastNarrative 時查詢源僅為 input", async () => {
    const capture = { value: "" };
    const deps = makeDeps(capture);
    const gen = runRecallBlock(deps as unknown as TurnDeps, "我向前走");
    let done = false;
    while (!done) { done = (await gen.next()).done ?? false; }
    expect(capture.value).toBe("我向前走");
  });
});
```

- [ ] **Step 2：執行測試確認 FAIL**

```bash
cd app && npx vitest run src/engine/turn/context-blocks.test.ts
```

Expected: FAIL（`runRecallBlock` 不接受第三參數）

- [ ] **Step 3：更新 `runRecallBlock` 簽名，加入 `lastNarrative` 參數**

在 `app/src/engine/turn/context-blocks.ts` 修改 `runRecallBlock`：

```typescript
const DEFAULT_RECALL_TOP_K = 5;
/** 最大查詢字元數：避免過長的上一回合敘事把向量模型拖慢 */
const MAX_RECALL_QUERY_LENGTH = 2000;

/**
 * 對 deps.recall（若有）以「上一回合敘事 + 玩家輸入」做語意檢索，格式化成 recallBlock。
 * lastNarrative：上一回合 Layer 1 產出的敘事段落（從 state.lastTurn?.narrative 傳入）；
 *   缺省時（opening 回合或 recall 首次）只用 input 查詢。
 */
export async function* runRecallBlock(
  deps: TurnDeps,
  input: string,
  lastNarrative?: string,
): AsyncGenerator<TurnEvent, string> {
  if (!deps.recall) return "";
  try {
    const query = [lastNarrative, input]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, MAX_RECALL_QUERY_LENGTH);
    const hits = await deps.recall.query(query, deps.recallTopK ?? DEFAULT_RECALL_TOP_K);
    return formatRecallBlock(hits);
  } catch (err) {
    yield { type: "warning" as const, message: `recall 檢索失敗，略過：${(err as Error).message}` };
    return "";
  }
}
```

- [ ] **Step 4：更新 turn/index.ts 傳入 lastNarrative**

在 `app/src/engine/turn/index.ts` 主空間回合 handler 中，`runRecallBlock` 呼叫改為：

```typescript
const recallBlock = yield* runRecallBlock(deps, input, state.lastTurn?.narrative ?? undefined);
```

副本回合 handler 中同樣：

```typescript
const recallBlock = yield* runRecallBlock(deps, input, state.lastTurn?.narrative ?? undefined);
```

（`state` 在兩個 handler 中都是已有的 `loadState` 結果）

- [ ] **Step 5：執行所有測試確認 PASS**

```bash
cd app && npx vitest run
```

Expected: 所有測試 PASS（包含 context-blocks.test.ts 三個新測試）

- [ ] **Step 6：Commit**

```bash
git add app/src/engine/turn/context-blocks.ts app/src/engine/turn/context-blocks.test.ts app/src/engine/turn/index.ts
git commit -m "feat: recall 查詢源改為上一回合敘事 + 玩家輸入，提升語意搜尋精準度"
```

---

## Self-Review

**Spec coverage check:**

| Spec 要求 | 對應 Task |
|-----------|---------|
| `sanitizeLoreId()` 函式，5 條正規化規則 | Task 1 |
| 套用到 `loadLoreFile` / `rewriteLoreFile` | Task 1 |
| `transition_dungeon_id` 套用 sanitize + schema 描述 | Task 2 |
| extraction prompt 3 條新規則 | Task 3 |
| `WIKI_FORMAT_HINT` 改為名稱登記冊格式 | Task 3 |
| category wiki 每回合注入 Layer 1 | Task 4 |
| wiki 不存在靜默降級 | Task 4（loadCategoryWikiBlock ENOENT catch）|
| recall 查詢源改為上一回合敘事 + input | Task 5 |
| 不改變 RECALL_ENABLED 開關 | Task 5（只改查詢邏輯）|

**Type consistency check:**

- `sanitizeLoreId` 定義於 Task 1，Task 2 import 路徑 `"../../engine/lore.js"` 正確
- `wikiBlock?: string` 加入 `BuildMessagesParams`（Task 4），`appendOptionalBlocks` 同步更新
- `runRecallBlock(deps, input, lastNarrative?)` 第三參數為 `string | undefined`，callers 傳 `state.lastTurn?.narrative ?? undefined` 型別相符

**Placeholder scan:** 無 TBD/TODO，所有步驟均有完整程式碼。
