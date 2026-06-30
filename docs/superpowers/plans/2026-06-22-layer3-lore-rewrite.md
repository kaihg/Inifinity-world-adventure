# Layer 3 reactive-lore-sync：append → 整檔重寫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Layer 3（reactive-lore-sync）從「append 帶日期區塊」改成「讀現有文件 + 本回合敘事片段 → LLM 整段重寫完整新版內容 → 引擎整檔覆寫」，解決訂正既有事實時無法精準定位片段的問題。

**Architecture:** 主腦敘事抽完事實後，Layer 3 先輸出一個輕量的 `touched_entities`（本回合摸到誰/哪個分類/相關原文片段）取代現有 8 個分散欄位；引擎對每個實體並行發一次「比較重寫」呼叫（讀現有 wiki.md 或角色檔全文 + 片段，要求輸出完整新版內容），再整檔覆寫。日期序由 git commit + raw log（journal.md/runs/\*.md）保留，wiki/角色檔不再自己維護 `## [date]` 區塊。

**Tech Stack:** TypeScript, Vitest, Zod（schema 驗證）, Node `fs/promises`。

## Global Constraints

- 所有新/改函式的失敗模式延續現有慣例：單筆失敗只 `log.warn` 並略過，不中斷其他筆、不讓 `runLoreSync` 拋錯（`pendingLoreSync.promise` 永遠 resolve）。
- 不寫遷移相容層：直接替換欄位/函式名稱，不保留舊欄位的相容解析（這是內部 LLM 契約，非外部 API）。
- 維持「機率判定不可由模型自由演」之外的既有鐵則不變：本計畫只動 Layer 3 lore 同步，不碰 Layer 1（敘事）、Layer 2（fast-control / now / 積分 / 轉場）。
- 每個 Task 結束都跑對應檔案的 `npm test`，全綠才進下一個 Task。
- 所有指令在 `app/` 目錄下執行。

---

## File Structure

| 檔案 | 改動 |
|---|---|
| `app/src/engine/schema.ts` | `LoreStateChangesSchema` 換成 `touched_entities` + `dungeon_wiki_excerpt`，新增 `LoreEntityRefSchema`/`LoreEntityRef` 型別 |
| `app/src/engine/schema.test.ts` | 對應更新 `parseLoreSyncOutput` 測試 |
| `app/src/engine/lore.ts` | 新增 `rewriteLoreWiki`（整檔覆寫），移除 `appendLoreReveals` |
| `app/src/engine/lore.test.ts` | 對應更新 |
| `app/src/engine/dungeon.ts` | 移除 `appendWikiReveals`（薄包裝，呼叫端改走 `rewriteLoreWiki`） |
| `app/src/engine/dungeon.test.ts` | 對應更新 |
| `app/src/engine/context.ts` | 新增 `rewriteNpcFile`（整檔覆寫角色檔）、`addCharacterIndexRow`（新 NPC 加入 index.md），移除 `appendNpcUpdates` |
| `app/src/engine/context.test.ts` | 對應更新 |
| `app/src/engine/turn.ts` | `LORE_SYNC_FORMAT_BLOCK` 改寫；新增 `callLoreRewrite`/`rewriteLoreEntity`；`runLoreSync` 整段改寫；`TurnPlan` 移除 `distill`/`wikiFilePath`、新增 `dungeonId`；`syncCharacterIndexStatus` 簽名改為 `npcIds: string[]`；移除 `applyLorePickups`、相關 import |
| `app/src/engine/turn.test.ts` | 對應更新 `buildLoreSyncMessages`、npc/item/dungeon 相關整合測試 |

---

### Task 1: Schema — `touched_entities` 取代分散欄位

**Files:**
- Modify: `app/src/engine/schema.ts:91-109`
- Test: `app/src/engine/schema.test.ts:182-209`

**Interfaces:**
- Produces: `LoreEntityRefSchema`（zod schema）、`type LoreEntityRef = z.infer<typeof LoreEntityRefSchema>`、`LoreSyncSchema`/`type LoreSync` 的新形狀 `{ state_changes: { touched_entities?: LoreEntityRef[]; dungeon_wiki_excerpt?: string } }`。後續所有 Task 都從 `./schema.js` import `LoreEntityRef`。

- [ ] **Step 1: 寫失敗的測試（取代舊的 182-209 行整塊）**

把 `app/src/engine/schema.test.ts` 第 182-209 行整段換成：

```typescript
describe("parseLoreSyncOutput（Layer 3：touched_entities + dungeon_wiki_excerpt，不需 awaiting/commit）", () => {
  it("接受 touched_entities（npc/item/location/skill）與 dungeon_wiki_excerpt", () => {
    const raw = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "ye-qing", category: "npc", name: "葉晴", excerpt: "葉晴的信任又提升了一點。" },
          { id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "撿到一根生鏽鐵管。" },
          { id: "info-room", category: "location", name: "資訊室", excerpt: "資訊室牆上有監視器。" },
          { id: "melee-mastery", category: "skill", name: "近戰格鬥精通", excerpt: "領悟了近戰格鬥精通。" },
        ],
        dungeon_wiki_excerpt: "資訊室牆上有監視器",
      },
    });
    const sync = parseLoreSyncOutput(raw);
    expect(sync.state_changes.touched_entities).toEqual([
      { id: "ye-qing", category: "npc", name: "葉晴", excerpt: "葉晴的信任又提升了一點。" },
      { id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "撿到一根生鏽鐵管。" },
      { id: "info-room", category: "location", name: "資訊室", excerpt: "資訊室牆上有監視器。" },
      { id: "melee-mastery", category: "skill", name: "近戰格鬥精通", excerpt: "領悟了近戰格鬥精通。" },
    ]);
    expect(sync.state_changes.dungeon_wiki_excerpt).toBe("資訊室牆上有監視器");
  });

  it("category 不在 npc/item/location/skill 之中時拋錯", () => {
    const raw = JSON.stringify({
      state_changes: {
        touched_entities: [{ id: "x", category: "monster", name: "x", excerpt: "x" }],
      },
    });
    expect(() => parseLoreSyncOutput(raw)).toThrow();
  });

  it("空物件也能解析（本回合沒有任何 lore 異動）", () => {
    const sync = parseLoreSyncOutput("{}");
    expect(sync.state_changes).toEqual({});
  });

  it("找不到 JSON 物件時拋錯", () => {
    expect(() => parseLoreSyncOutput("完全沒有大括號")).toThrow();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/schema.test.ts`
Expected: FAIL（`sync.state_changes.touched_entities` 為 `undefined`，因為 schema 還沒改）

- [ ] **Step 3: 改 schema.ts**

把 `app/src/engine/schema.ts` 第 91-109 行（`/** Layer 3...*/` 註解開始到 `export type LoreSync = ...` 結束）換成：

```typescript
/** Layer 3（reactive-lore-sync）：本回合摸到的實體列表 + 副本本身的揭露片段，皆可省略 */
const LoreEntityRefSchema = z.object({
  id: z.string(),
  category: z.enum(["npc", "item", "location", "skill"]),
  name: z.string(),
  excerpt: z.string(),
});

export type LoreEntityRef = z.infer<typeof LoreEntityRefSchema>;

const LoreStateChangesSchema = z
  .object({
    touched_entities: z.array(LoreEntityRefSchema).optional(),
    dungeon_wiki_excerpt: z.string().optional(),
  })
  .default({});

export const LoreSyncSchema = z.object({
  state_changes: LoreStateChangesSchema,
});

export type LoreSync = z.infer<typeof LoreSyncSchema>;
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/schema.ts app/src/engine/schema.test.ts
git commit -m "refactor(engine): Layer 3 schema 改用 touched_entities 取代分散欄位"
```

---

### Task 2: lore.ts — `rewriteLoreWiki` 取代 `appendLoreReveals`

**Files:**
- Modify: `app/src/engine/lore.ts`
- Test: `app/src/engine/lore.test.ts`

**Interfaces:**
- Consumes: `loreDir`、`LoreCategory`（已存在，不變）
- Produces: `export async function rewriteLoreWiki(worldDir: string, category: LoreCategory, id: string, content: string, title: string, logger?: Logger): Promise<void>`。Task 3（dungeon.ts）與 Task 6（turn.ts）都呼叫這個函式。

- [ ] **Step 1: 寫失敗的測試**

把 `app/src/engine/lore.test.ts` 第 38-53 行（`appendLoreReveals 首次建立...` 與 `appendLoreReveals 傳空陣列...` 兩個 it）換成：

```typescript
  it("rewriteLoreWiki 首次建立 wiki.md（無現有檔案時自動補標題）", async () => {
    await rewriteLoreWiki(world, "skills", "melee-mastery", "可疊加三層，疊滿後解鎖突進。", "技能（melee-mastery）");
    const wiki = await readFile(path.join(world, "skills", "melee-mastery", "wiki.md"), "utf8");
    expect(wiki).toContain("技能（melee-mastery）");
    expect(wiki).toContain("可疊加三層，疊滿後解鎖突進。");
  });

  it("rewriteLoreWiki 第二次呼叫整檔覆寫，不殘留舊內容", async () => {
    await rewriteLoreWiki(world, "skills", "melee-mastery", "可疊加三層。", "技能（melee-mastery）");
    await rewriteLoreWiki(world, "skills", "melee-mastery", "可疊加五層，疊滿解鎖突進。", "技能（melee-mastery）");
    const wiki = await readFile(path.join(world, "skills", "melee-mastery", "wiki.md"), "utf8");
    expect(wiki).toContain("可疊加五層，疊滿解鎖突進。");
    expect(wiki).not.toContain("可疊加三層。");
  });

  it("LLM 輸出本身已含 # 標題時不重複加標題", async () => {
    await rewriteLoreWiki(world, "items", "rusty-pipe", "# 道具（rusty-pipe）\n\n管身刻有符號。", "道具（rusty-pipe）");
    const wiki = await readFile(path.join(world, "items", "rusty-pipe", "wiki.md"), "utf8");
    expect(wiki.match(/# 道具（rusty-pipe）/g)).toHaveLength(1);
  });
```

把檔案最上方 import 從：

```typescript
import { loadLore, ensureSecrets, appendLoreReveals } from "./lore.js";
```

換成：

```typescript
import { loadLore, ensureSecrets, rewriteLoreWiki } from "./lore.js";
```

並把第 55-61 行（`loadLore 讀到 ensureSecrets/appendLoreReveals 寫入的內容` 與 `locations 分類沿用同一套規則` 兩個 it）裡的 `appendLoreReveals(world, "dungeons", "U-001", ["入口大廳有三道門"], "2026-06-19", "title")` 換成 `rewriteLoreWiki(world, "dungeons", "U-001", "入口大廳有三道門", "title")`，`appendLoreReveals(world, "locations", "info-room", ["牆上有一面鏡子"], "2026-06-19", "title")` 換成 `rewriteLoreWiki(world, "locations", "info-room", "牆上有一面鏡子", "title")`。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/lore.test.ts`
Expected: FAIL（`rewriteLoreWiki` 不存在）

- [ ] **Step 3: 實作 `rewriteLoreWiki`，移除 `appendLoreReveals`**

把 `app/src/engine/lore.ts` 第 83-103 行（`/** 把已揭露的知識提煉進 wiki.md...*/` 整個函式）換成：

```typescript
/**
 * 把該 lore 對象的 wiki.md 整檔覆寫為新內容（不再 append 帶日期區塊；
 * 時間序交給 git commit 歷史與 raw log 保留，wiki.md 只負責「目前最好的一份完整知識」）。
 * 內容若已含 `#` 開頭的標題就直接寫入，否則自動補一個標題行。
 */
export async function rewriteLoreWiki(
  worldDir: string,
  category: LoreCategory,
  id: string,
  content: string,
  title: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  logger.debug({ category, id }, "整檔重寫 wiki.md");
  const dir = loreDir(worldDir, category, id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "wiki.md");
  const body = content.trim();
  const finalContent = body.startsWith("#") ? `${body}\n` : `# ${title}\n\n${body}\n`;
  await writeFile(file, finalContent, "utf8");
}
```

同時移除檔案開頭 import 中不再用到的 `appendFile`（第 1 行原本是 `import { readFile, writeFile, appendFile, mkdir, access } from "node:fs/promises";`，改成 `import { readFile, writeFile, mkdir, access } from "node:fs/promises";`）。

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/lore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/lore.ts app/src/engine/lore.test.ts
git commit -m "refactor(engine): lore wiki 落地改整檔覆寫，移除 append 日期區塊"
```

---

### Task 3: dungeon.ts — 移除 `appendWikiReveals` 薄包裝

**Files:**
- Modify: `app/src/engine/dungeon.ts:1-4,120-129`
- Test: `app/src/engine/dungeon.test.ts:1-14,89-92`

**Interfaces:**
- Consumes: `rewriteLoreWiki`（Task 2 產出）
- Produces: 無新 export；呼叫端（Task 6 的 turn.ts、本 Task 的測試）改直接呼叫 `rewriteLoreWiki(worldDir, "dungeons", dungeonId, content, title)`。

- [ ] **Step 1: 改測試（先讓它對著還不存在的呼叫方式失敗）**

把 `app/src/engine/dungeon.test.ts` 第 5-14 行 import 改成：

```typescript
import {
  parseActiveDungeon,
  formatActiveDungeon,
  nextRunId,
  enterDungeon,
  appendRun,
  loadDungeonLore,
  listDungeonIds,
} from "./dungeon.js";
import { rewriteLoreWiki } from "./lore.js";
```

把第 39 行 describe 標題與第 89-91 行換成：

```typescript
describe("enterDungeon / appendRun / loadDungeonLore", () => {
```

```typescript
    await rewriteLoreWiki(world, "dungeons", "U-001", "入口大廳有三道門", "副本 U-001 · 已揭露知識（Wiki）");
    const lore2 = await loadDungeonLore(world, "U-001");
    expect(lore2.wiki).toContain("三道門");
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/dungeon.test.ts`
Expected: FAIL（`appendWikiReveals` 還被 dungeon.ts import/export，但測試已經不用它——這一步主要是確認移除前測試先對齊新介面；若此時仍 PASS 也可以，因為 dungeon.ts 還沒變動，直接進 Step 3）

- [ ] **Step 3: 移除 dungeon.ts 裡的 `appendWikiReveals`**

把 `app/src/engine/dungeon.ts` 第 1-4 行：

```typescript
import { writeFile, appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { loadLore, ensureSecrets, appendLoreReveals } from "./lore.js";
```

換成：

```typescript
import { writeFile, appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { loadLore, ensureSecrets } from "./lore.js";
```

並刪除第 120-129 行整個 `appendWikiReveals` 函式（含上面的註解行）：

```typescript
/** 把本回合已揭露的知識提煉進 wiki.md（append；wiki 不存在則建立） */
export async function appendWikiReveals(
  worldDir: string,
  dungeonId: string,
  reveals: string[],
  date: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  await appendLoreReveals(worldDir, "dungeons", dungeonId, reveals, date, `副本 ${dungeonId} · 已揭露知識（Wiki）`, logger);
}

```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/dungeon.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/dungeon.ts app/src/engine/dungeon.test.ts
git commit -m "refactor(engine): 移除 appendWikiReveals 薄包裝，呼叫端改直接用 rewriteLoreWiki"
```

---

### Task 4: context.ts — `rewriteNpcFile` + `addCharacterIndexRow` 取代 `appendNpcUpdates`

**Files:**
- Modify: `app/src/engine/context.ts:1,205-233`
- Test: `app/src/engine/context.test.ts:5-16,258-304`

**Interfaces:**
- Produces:
  - `export async function rewriteNpcFile(worldDir: string, id: string, content: string, logger?: Logger): Promise<void>` — 整檔覆寫 `characters/<id>.md`（id 不合法時靜默略過，不寫檔）。
  - `export function addCharacterIndexRow(md: string, id: string, name: string): string` — 純函式，`characters/index.md` 表格已有該 id 則原樣回傳，否則在表尾加一列。
  - `NPC_ID_RE` 維持 export 不變（Task 6 的 turn.ts 會用到）。

- [ ] **Step 1: 寫失敗的測試**

把 `app/src/engine/context.test.ts` 第 13 行 `appendNpcUpdates,` 換成 `rewriteNpcFile,\n  addCharacterIndexRow,`。

把第 258-304 行（整個 `describe("appendNpcUpdates", ...)` 區塊）換成：

```typescript
describe("rewriteNpcFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "iwa-npc-rewrite-"));
    await mkdir(path.join(dir, "characters"), { recursive: true });
    await writeFile(path.join(dir, "characters", "yeqing.md"), "# 葉晴\n前特種部隊教官\n", "utf8");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("整檔覆寫既有角色檔，不殘留舊內容", async () => {
    await rewriteNpcFile(dir, "yeqing", "# 葉晴\n\n前特種部隊教官，對沈奕的信任已經提升。");
    const md = await readFile(path.join(dir, "characters", "yeqing.md"), "utf8");
    expect(md).toContain("信任已經提升");
    expect(md).not.toContain("前特種部隊教官\n"); // 舊版單獨一行的描述已被新版整段取代
  });

  it("角色檔不存在時直接建立（新 NPC）", async () => {
    await rewriteNpcFile(dir, "newcomer", "# 新來的人\n\n剛剛登場。");
    const md = await readFile(path.join(dir, "characters", "newcomer.md"), "utf8");
    expect(md).toContain("剛剛登場");
  });

  it("id 含路徑分隔符等不合法字元時靜默略過，不寫出檔案", async () => {
    await rewriteNpcFile(dir, "../escape", "嘗試逃出 characters/");
    const escaped = await readFile(path.join(dir, "escape.md"), "utf8").catch(() => null);
    expect(escaped).toBeNull();
  });
});

describe("addCharacterIndexRow", () => {
  const INDEX = [
    "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
    "|----|------|------|----------|--------------|",
    "| yeqing | 葉晴 | NPC | 結盟 | - |",
  ].join("\n");

  it("id 已存在時原樣回傳，不重複加列", () => {
    expect(addCharacterIndexRow(INDEX, "yeqing", "葉晴")).toBe(INDEX);
  });

  it("id 不存在時在表尾加一列", () => {
    const result = addCharacterIndexRow(INDEX, "newcomer", "新來的人");
    expect(result).toContain("| yeqing | 葉晴 | NPC | 結盟 | - |");
    expect(result).toContain("| newcomer | 新來的人 | NPC | 初次登場 | - |");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/context.test.ts`
Expected: FAIL（`rewriteNpcFile`/`addCharacterIndexRow` 不存在）

- [ ] **Step 3: 實作**

把 `app/src/engine/context.ts` 第 1 行：

```typescript
import { readFile, appendFile } from "node:fs/promises";
```

換成：

```typescript
import { readFile, writeFile, appendFile } from "node:fs/promises";
```

把第 204-233 行（`/** 防止路徑穿越...*/` 到 `appendNpcUpdates` 函式結尾）換成：

```typescript
/** 防止路徑穿越：NPC id 只允許英數字、連字號、底線、點（不含路徑分隔符） */
export const NPC_ID_RE = /^[\w.-]+$/;

/**
 * 把模型重寫後的完整內容整檔覆寫進 characters/<id>.md（新 NPC 時等同建檔）。
 * id 不合法時靜默略過，不寫出檔案，不中斷呼叫端的其他筆。
 */
export async function rewriteNpcFile(
  worldDir: string,
  id: string,
  content: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  if (!NPC_ID_RE.test(id)) {
    logger.warn({ id }, "touched_entities 含不合法 NPC id，略過");
    return;
  }
  const file = path.join(worldDir, "characters", `${id}.md`);
  await writeFile(file, `${content.trim()}\n`, "utf8");
}

/**
 * 若 characters/index.md 表格尚未有該 id，在表尾新增一列（新 NPC 首次登場）；
 * 已存在則原樣回傳（避免重複列）。
 */
export function addCharacterIndexRow(md: string, id: string, name: string): string {
  if (parseCharacterIndex(md).some((npc) => npc.id === id)) return md;
  const row = `| ${id} | ${name} | NPC | 初次登場 | - |`;
  return `${md.trimEnd()}\n${row}\n`;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/context.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/context.ts app/src/engine/context.test.ts
git commit -m "refactor(engine): NPC 角色檔落地改整檔覆寫，新增 index.md 新角色掛載"
```

---

### Task 5: turn.ts — `LORE_SYNC_FORMAT_BLOCK` 與 `buildLoreSyncMessages` 對齊新 schema

**Files:**
- Modify: `app/src/engine/turn.ts:138-150`
- Test: `app/src/engine/turn.test.ts:228-256`

**Interfaces:**
- Consumes: 無新依賴（純文字常數）
- Produces: 更新後的 prompt 文字，供 Task 6 的 `runLoreSync` 重寫沿用。

- [ ] **Step 1: 改測試**

把 `app/src/engine/turn.test.ts` 第 228-256 行（整個 `describe("buildLoreSyncMessages（Layer 3）", ...)`）換成：

```typescript
describe("buildLoreSyncMessages（Layer 3）", () => {
  it("system 含 touched_entities/dungeon_wiki_excerpt 欄位說明，不含 mode_transition/awaiting_user_input", () => {
    const msgs = buildLoreSyncMessages({
      settingText: "設定", state: sampleState, input: "我四處看看",
      narrative: "沈奕在資訊室撿到一根生鏽鐵管。",
      dicePool: [42, 7], existingDungeonIds: ["U-001"],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("touched_entities");
    expect(msgs[0].content).toContain("dungeon_wiki_excerpt");
    expect(msgs[0].content).toContain("npc/item/location/skill");
    expect(msgs[0].content).not.toContain("awaiting_user_input");
    expect(msgs[0].content).not.toContain("mode_transition");
    expect(msgs[0].content).toContain("沈奕在資訊室撿到一根生鏽鐵管");
    expect(msgs[1].content).toContain("我四處看看");
  });

  it("副本：system 帶 wiki 與 dungeonId，不外洩 secrets", () => {
    const msgs = buildLoreSyncMessages({
      settingText: "設定", state: sampleState, input: "往前走",
      narrative: "沈奕抵達出口。", dicePool: [5], existingDungeonIds: ["U-001"],
      dungeonId: "U-001", wiki: "入口有三道門", secrets: "地板會塌",
    });
    expect(msgs[0].content).toContain("U-001");
    expect(msgs[0].content).toContain("入口有三道門");
    expect(msgs[0].content).not.toContain("地板會塌");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn.test.ts -t "buildLoreSyncMessages"`
Expected: FAIL（內容還是舊欄位名稱）

- [ ] **Step 3: 改 `LORE_SYNC_FORMAT_BLOCK`**

把 `app/src/engine/turn.ts` 第 138-150 行換成：

```typescript
const LORE_SYNC_FORMAT_BLOCK = [
  "## 輸出格式（務必嚴格遵守）",
  "只輸出**單一 JSON 物件**，不要任何前言、後語或程式碼框。欄位：",
  "- state_changes: { touched_entities?: [{id, category, name, excerpt}], dungeon_wiki_excerpt?: string }",
  "  - touched_entities：本回合敘事中明確登場、或知識被進一步揭露/訂正的 NPC、道具、場景、技能。",
  "    category 只能是 npc/item/location/skill 其中之一；id 用英數小寫 slug；name 用顯示名稱；",
  "    excerpt 是本回合敘事中跟這個實體有關的原文片段（之後會有另一步驟拿這段片段去跟現有檔案比較、",
  "    決定怎麼更新，你不需要自己組好最終的完整內容，只要把相關原文片段填進來）。",
  "  - dungeon_wiki_excerpt：劇情中對**當前副本本身**新揭露的知識片段（地圖/機關/規則），不在副本中則省略。",
  "（本回合若沒有任何相關異動，對應欄位省略或留空陣列即可，不要硬湊內容）",
].join("\n");
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn.test.ts -t "buildLoreSyncMessages"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn.ts app/src/engine/turn.test.ts
git commit -m "refactor(engine): Layer 3 prompt 改用 touched_entities 格式說明"
```

---

### Task 6: turn.ts — 重寫 `runLoreSync` 主流程

這是核心 Task：新增「比較重寫」呼叫、改寫 `runLoreSync` 的分派邏輯、調整 `TurnPlan`、`syncCharacterIndexStatus` 簽名，並移除已死的程式碼路徑。

**Files:**
- Modify: `app/src/engine/turn.ts`（多處，見下）
- Test: `app/src/engine/turn.test.ts`（多處，見下）

**Interfaces:**
- Consumes: `LoreEntityRef`（Task 1）、`rewriteLoreWiki`（Task 2）、`rewriteNpcFile`/`addCharacterIndexRow`/`NPC_ID_RE`（Task 4）
- Produces: 無新 export 給其他檔案（`callLoreRewrite`/`rewriteLoreEntity` 為 turn.ts 內部私有函式，跟現有 `applyLorePickups`/`generateItemSecrets` 慣例一致，只透過 `runMainSpaceTurn`/`runDungeonTurn` 整合測試驗證）。`TurnPlan.dungeonId?: string` 取代 `distill`/`wikiFilePath`。

#### Step 1: 改測試 — 先把所有受影響的整合測試改成新行為的期望值

**1a. 把 `app/src/engine/turn.test.ts` 第 389-528 行（`npc_updates 同步用小模型摘要...` 到 `item_pickups 對已有 secrets 的道具不重複生成` 四個 it）整段換成：**

```typescript
  it("touched_entities（npc）：整檔重寫角色檔，並用小模型摘要同步進 characters/index.md", async () => {
    await writeFile(path.join(world, "characters", "yeqing.md"), "# 葉晴\n- 姓名：葉晴\n前特種部隊教官\n", "utf8");
    await writeFile(
      path.join(world, "characters", "index.md"),
      [
        "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
        "|----|------|------|----------|--------------|",
        "| yeqing | 葉晴 | NPC | 結盟 | - |",
      ].join("\n"),
      "utf8",
    );
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "yeqing", category: "npc", name: "葉晴", excerpt: "葉晴點點頭，眼神多了幾分信任。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "葉晴信任提升",
    });
    const events: TurnEvent[] = [];
    // 序列：主腦敘事 → Layer 2 fast-control(ctrl) → Layer 3 抽取(ctrl) → 比較重寫(新版角色檔全文)
    for await (const ev of runMainSpaceTurn(
      {
        client: sequencedClient([
          "葉晴點點頭，眼神多了幾分信任。",
          ctrl,
          ctrl,
          "# 葉晴\n- 姓名：葉晴\n前特種部隊教官，對沈奕的信任進一步提升。",
        ]),
        characterClient: fakeClient(["信任大幅提升"]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "和葉晴交談",
    )) {
      events.push(ev);
    }
    const yeqing = await readFile(path.join(world, "characters", "yeqing.md"), "utf8");
    expect(yeqing).toContain("對沈奕的信任進一步提升");
    const index = await readFile(path.join(world, "characters", "index.md"), "utf8");
    expect(index).toContain("| yeqing | 葉晴 | NPC | 信任大幅提升 | - |");
  });

  it("touched_entities（npc，全新角色）：建檔並掛進 characters/index.md", async () => {
    await writeFile(
      path.join(world, "characters", "index.md"),
      ["| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |", "|----|------|------|----------|--------------|"].join("\n"),
      "utf8",
    );
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "newcomer", category: "npc", name: "陌生男子", excerpt: "一名陌生男子從陰影中走出，自稱姓陳。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "新角色登場",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: sequencedClient([
          "一名陌生男子從陰影中走出，自稱姓陳。",
          ctrl,
          ctrl,
          "# 陳先生\n\n自稱姓陳的陌生男子，來歷不明。",
        ]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "觀察陌生男子",
    )) {
      events.push(ev);
    }
    const newcomer = await readFile(path.join(world, "characters", "newcomer.md"), "utf8");
    expect(newcomer).toContain("來歷不明");
    const index = await readFile(path.join(world, "characters", "index.md"), "utf8");
    expect(index).toContain("| newcomer | 陳先生 | NPC | 初次登場 | - |");
  });

  it("touched_entities（item，全新）：首次生成 secrets.md，並把比較重寫的內容整檔寫進 wiki.md", async () => {
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "沈奕從地上撿起一根生鏽鐵管，管身刻有奇怪符號。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "撿到鐵管",
    });
    const events: TurnEvent[] = [];
    // 序列：主腦敘事 → Layer 2(ctrl) → Layer 3 抽取(ctrl) → 道具 secrets 生成（generateItemSecrets 用 deps.client）→ 比較重寫
    for await (const ev of runMainSpaceTurn(
      {
        client: sequencedClient([
          "沈奕從地上撿起一根生鏽鐵管，管身刻有奇怪符號。",
          ctrl,
          ctrl,
          "其實是某把武器的殘骸，蘊含未知力量。",
          "# 道具（rusty-pipe）\n\n管身刻有奇怪符號，來歷不明。",
        ]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "撿起鐵管",
    )) {
      events.push(ev);
    }
    const secrets = await readFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "utf8");
    expect(secrets).toContain("某把武器的殘骸");
    const wiki = await readFile(path.join(world, "items", "rusty-pipe", "wiki.md"), "utf8");
    expect(wiki).toContain("管身刻有奇怪符號，來歷不明");
  });

  it("touched_entities（item，已有 secrets）：不重複生成 secrets，只整檔重寫 wiki", async () => {
    await mkdir(path.join(world, "items", "rusty-pipe"), { recursive: true });
    await writeFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "# 道具隱藏設定（生鏽鐵管）\n\n原始真相\n");
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "沈奕又看了一眼鐵管，發現符號似乎在發光。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "再次檢視鐵管",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: sequencedClient([
          "沈奕又看了一眼鐵管，發現符號似乎在發光。",
          ctrl,
          ctrl,
          "# 道具（rusty-pipe）\n\n管身符號會微微發光。",
        ]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "再看看鐵管",
    )) {
      events.push(ev);
    }
    const secrets = await readFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "utf8");
    expect(secrets).toContain("原始真相");
    const wiki = await readFile(path.join(world, "items", "rusty-pipe", "wiki.md"), "utf8");
    expect(wiki).toContain("管身符號會微微發光");
  });
```

**1b. 把第 631-670 行（`describe("runDungeonTurn", ...)` 內 `落地到 runs/*.md、提煉 wiki_reveals 進 wiki.md`）換成：**

```typescript
describe("runDungeonTurn", () => {
  it("落地到 runs/*.md、整檔重寫副本 wiki.md（dungeon_wiki_excerpt）", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(path.join(world, "dungeons", "U-001", "secrets.md"), "真相：地板會塌\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    const narrative = "你踏入大廳，三道門並排。";
    const ctrl = JSON.stringify({
      state_changes: { dungeon_wiki_excerpt: "入口大廳有三道門" },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "進入大廳",
    });

    const events: TurnEvent[] = [];
    // 序列：主腦敘事(client) → Layer 2(controlClient) → Layer 3 抽取(controlClient，loreClient 缺省退回) → 比較重寫(controlClient)
    for await (const ev of runDungeonTurn(
      {
        client: fakeClient([narrative]),
        controlClient: sequencedClient([ctrl, ctrl, "# 副本 U-001 · 已揭露知識（Wiki）\n\n入口大廳有三道門。"]),
        worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [5],
      },
      "往前走",
    )) {
      events.push(ev);
    }

    const run = await readFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "utf8");
    expect(run).toContain("## [2026-06-19] 進入大廳");
    expect(run).toContain("往前走");
    const wiki = await readFile(path.join(world, "dungeons", "U-001", "wiki.md"), "utf8");
    expect(wiki).toContain("入口大廳有三道門");
    // journal 不該被副本回合寫入
    const journalExists = await readFile(path.join(world, "journal.md"), "utf8").then(() => true).catch(() => false);
    expect(journalExists).toBe(false);
  });
});
```

**1c. 把第 863-894 行（`副本回合結束後重新索引 run log 與 wiki（有 wiki_reveals 時）`）換成：**

```typescript
  it("副本回合結束後重新索引 run log 與 wiki（有 dungeon_wiki_excerpt 時）", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(path.join(world, "dungeons", "U-001", "secrets.md"), "真相：地板會塌\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    const ctrlJson = JSON.stringify({
      state_changes: { dungeon_wiki_excerpt: "入口大廳有三道門" },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "進入大廳",
    });
    const response = "你踏入大廳，三道門並排。\n===STATE===\n" + ctrlJson;

    const recall = fakeRecall();
    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(
      {
        client: fakeClient([response]),
        loreClient: sequencedClient([ctrlJson, "# 副本 U-001 · 已揭露知識（Wiki）\n\n入口大廳有三道門。"]),
        worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [5], recall,
      },
      "往前走",
    )) {
      events.push(ev);
    }

    const relPaths = recall.upserted.map((u) => u.relPath);
    expect(relPaths).toContain(path.join("dungeons", "U-001", "runs", "run-1.md"));
    expect(relPaths).toContain(path.join("dungeons", "U-001", "wiki.md"));
  });
```

**1d. 把第 897-942 行（`enter_dungeon → 生成 secrets/建 run → 副本回合 → settle_dungeon 回主空間`）裡的 `settleCtl` 與 client 序列換成：**

```typescript
    const settleCtl = JSON.stringify({
      state_changes: { dungeon_wiki_excerpt: "出口在東側" }, rolls: [], mode_transition: "settle_dungeon",
      awaiting_user_input: true, suggested_actions: [], commit_summary: "撤離副本",
    });
    const client = twoBrainClient([
      "系統警報響起。",     // turn 0 主腦（主空間）
      enterCtl,            // turn 0 Layer 2 fast-control → enter_dungeon
      enterCtl,            // turn 0 Layer 3 抽取（無 lore 欄位，no-op）
      "這個副本真正的機關是潮汐淹沒。", // secrets 生成（generateSecrets 用 deps.client）
      "你抵達出口。",       // turn 1 主腦（副本）
      settleCtl,           // turn 1 Layer 2 fast-control → settle_dungeon
      settleCtl,           // turn 1 Layer 3 抽取 → dungeon_wiki_excerpt
      "# 副本 U-TEST · 已揭露知識（Wiki）\n\n出口在東側。", // 比較重寫
    ]);
```

（其餘該測試內容、斷言不變，`wiki).toContain("出口在東側")` 依然成立。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn.test.ts`
Expected: FAIL（大量 file-not-found / content 不符，因為 `runLoreSync` 還是舊邏輯）

- [ ] **Step 3: 改 `turn.ts` import 區塊**

把第 5-15 行（從 `context.js` 的 import）換成：

```typescript
import {
  loadState,
  parseNow,
  parseProtagonist,
  applyPointsDelta,
  applyProtagonistUpdates,
  rewriteNpcFile,
  addCharacterIndexRow,
  applyIndexStatusUpdates,
  NPC_ID_RE,
  type GameState,
} from "./context.js";
```

把第 25-34 行（`schema.js`/`dungeon.js` import）換成：

```typescript
import {
  parseFastControlOutput,
  parseLoreSyncOutput,
  type FastControl,
  type LoreEntityRef,
} from "./schema.js";
import {
  parseActiveDungeon,
  formatActiveDungeon,
  enterDungeon,
  appendRun,
  loadDungeonLore,
  listDungeonIds,
} from "./dungeon.js";
```

把第 34 行（lore.js import）換成：

```typescript
import { loadLore, ensureSecrets, rewriteLoreWiki, loreDir, type LoreCategory } from "./lore.js";
```

（`lore.ts` 目前沒有 export `loreDir`——已經有，見 `app/src/engine/lore.ts:24` 的 `export function loreDir`，不用額外改 lore.ts。）

- [ ] **Step 4: 改 `syncCharacterIndexStatus` 簽名（第 373-398 行）**

換成：

```typescript
/**
 * 把本回合有 touched 的 NPC id，用小模型（characterClient，缺省退回主 client）
 * 各自讀取（已被整檔重寫過的）最新角色檔摘要成一句近況，同步進 characters/index.md 的「最近狀態」欄。
 * 不用主敘事模型：這只是省 context 的索引摘要，不需要主敘事的推理力。
 * 單筆摘要失敗只略過該筆，不中斷其他筆、不影響回合本身。
 */
async function syncCharacterIndexStatus(
  deps: TurnDeps,
  npcIds: string[],
  log: Logger,
): Promise<void> {
  const summaryClient = deps.characterClient ?? deps.client;
  const entries = await Promise.all(
    npcIds.map(async (id): Promise<readonly [string, string] | null> => {
      const characterMd = await readBestEffort(path.join(deps.worldDir, "characters", `${id}.md`));
      if (!characterMd) return null;
      const name = parseProtagonist(characterMd).name || id;
      const status = await summarizeNpcStatus({ name, characterMd, client: summaryClient });
      return status ? [id, status] : null;
    }),
  );
  const statusUpdates = Object.fromEntries(
    entries.filter((e): e is readonly [string, string] => e !== null),
  );
  if (Object.keys(statusUpdates).length === 0) return;

  const indexPath = path.join(deps.worldDir, "characters", "index.md");
  const indexMd = await readBestEffort(indexPath);
  if (!indexMd) return;
  await writeFile(indexPath, applyIndexStatusUpdates(indexMd, statusUpdates), "utf8");
  log.debug({ statusUpdates }, "同步 characters/index.md 近況欄");
}
```

- [ ] **Step 5: 移除 `applyLorePickups`，新增 `callLoreRewrite` + `rewriteLoreEntity`（取代第 400-441 行）**

把第 400-441 行（`ITEM_ID_RE` 常數開始到 `applyLorePickups` 函式結尾）整段換成：

```typescript
/** 防止路徑穿越：道具/場景/技能/副本 id 只允許英數字、連字號、底線、點（不含路徑分隔符） */
const ITEM_ID_RE = /^[\w.-]+$/;

/** 為指定道具生成隱藏設定（劇透文件，僅供暗線一致，不可外洩）；風格與 generateSecrets 對齊 */
async function generateItemSecrets(client: LlmClient, settingText: string, itemName: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是本世界的道具設計者。為指定道具生成隱藏設定（真實來歷、隱藏效果、與主線的關聯）。" +
        "這是劇透文件，玩家永遠不會直接看到，只供敘事暗線一致。只輸出設定內容本身，繁體中文，不要前言或客套。\n\n" +
        "世界設定：\n" + settingText.trim(),
    },
    { role: "user", content: `道具名稱：${itemName}。請生成其隱藏設定。` },
  ];
  let full = "";
  for await (const d of client.streamChat(messages)) full += d;
  return full.trim() || "（生成失敗，待補）";
}

const ENTITY_CATEGORY_TO_LORE: Record<"item" | "location" | "skill", LoreCategory> = {
  item: "items",
  location: "locations",
  skill: "skills",
};

const ENTITY_CATEGORY_TITLE: Record<"item" | "location" | "skill", string> = {
  item: "道具",
  location: "場景",
  skill: "技能",
};

/**
 * 把【現有文件全文】+【本回合相關敘事片段】丟給 LLM，要求輸出完整新版內容（不是 diff、不是片段）。
 * 失敗或輸出空白時回 null，呼叫端視為「這筆略過」。
 */
async function callLoreRewrite(
  client: LlmClient,
  settingText: string,
  excerpt: string,
  docTitle: string,
  existingContent: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是本世界敘事引擎的知識庫維護者。任務：把【現有文件】依【本回合敘事片段】更新成一份完整、連貫的新版內容。",
        "鐵則：",
        "- 只輸出文件完整新版內容本身（純文字/Markdown），不要 JSON、不要前言、不要程式碼框。",
        "- 不可遺漏現有文件中仍然成立的事實；只在片段明確提供新資訊或訂正時才改動對應部分。",
        "- 不可發明片段未提及的事實。",
        "",
        "世界設定：",
        settingText.trim(),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `文件標題：${docTitle}`,
        "",
        existingContent.trim()
          ? `現有文件全文：\n${existingContent.trim()}`
          : "（目前沒有現有文件，這是全新建檔）",
        "",
        `本回合敘事片段：\n${excerpt.trim()}`,
      ].join("\n"),
    },
  ];
  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
  } catch {
    return null;
  }
  const content = raw.trim();
  return content.length > 0 ? content : null;
}

interface LoreRewriteResult {
  id: string;
  category: "npc" | "item" | "location" | "skill" | "dungeon";
  title: string;
  content: string;
}

/**
 * 對單一 touched entity：讀現有文件（NPC 角色檔 / 道具場景技能 wiki.md，缺檔視為全新建檔），
 * 若是道具/場景/技能且尚無 secrets 則先生成一次，再呼叫 callLoreRewrite 取得整檔新內容。
 * 單筆失敗（id 不合法 / LLM 呼叫失敗）回 null，不中斷其他筆。
 */
async function rewriteLoreEntity(
  deps: TurnDeps,
  settingText: string,
  entity: LoreEntityRef,
  log: Logger,
): Promise<LoreRewriteResult | null> {
  const rewriteClient = deps.loreClient ?? deps.controlClient ?? deps.client;

  if (entity.category === "npc") {
    if (!NPC_ID_RE.test(entity.id)) {
      log.warn({ entity }, "touched_entities 含不合法 NPC id，略過");
      return null;
    }
    const filePath = path.join(deps.worldDir, "characters", `${entity.id}.md`);
    const existing = await readBestEffort(filePath);
    const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, `NPC 角色檔案（${entity.name}）`, existing);
    if (!content) return null;
    return { id: entity.id, category: "npc", title: entity.name, content };
  }

  if (!ITEM_ID_RE.test(entity.id)) {
    log.warn({ entity }, "touched_entities 含不合法 id，略過");
    return null;
  }
  const category = ENTITY_CATEGORY_TO_LORE[entity.category];
  const existing = await loadLore(deps.worldDir, category, entity.id, log);
  if (!existing.secrets) {
    const secretsText = await generateItemSecrets(deps.client, settingText, entity.name);
    await ensureSecrets(deps.worldDir, category, entity.id, secretsText, `隱藏設定（${entity.name}）`, log);
  }
  const title = `${ENTITY_CATEGORY_TITLE[entity.category]}（${entity.id}）`;
  const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, title, existing.wiki);
  if (!content) return null;
  return { id: entity.id, category: entity.category, title, content };
}
```

- [ ] **Step 6: 改 `TurnPlan`（第 445-460 行）**

換成：

```typescript
interface TurnPlan {
  /** 主腦（敘事）訊息 */
  messages: ChatMessage[];
  /** Layer 2（fast-control）訊息建構器：拿主腦完整敘事，回傳 fast-control 對話 */
  buildFastControl: (narrative: string) => ChatMessage[];
  /** Layer 3（reactive-lore-sync）訊息建構器：拿主腦完整敘事，回傳 lore-sync 對話 */
  buildLoreSync: (narrative: string) => ChatMessage[];
  /** raw 層落地：主空間→journal，副本→runs/<run>.md */
  appendRaw: (entry: { date: string; title: string; body: string }) => Promise<void>;
  /** raw 層檔案絕對路徑（journal.md 或 runs/<run>.md），供回合結束後重建語意索引用 */
  rawFilePath: string;
  /** 當前副本 id（僅副本回合有），供 Layer 3 落地 dungeon_wiki_excerpt 用 */
  dungeonId?: string;
}
```

- [ ] **Step 7: 改 `runMainSpaceTurn`/`runDungeonTurn` 的 plan 物件**

`runMainSpaceTurn` 內（第 801-809 行）不需要改動（本來就沒有 `distill`/`wikiFilePath`）。

`runDungeonTurn` 內，把第 836-857 行的 plan 物件換成：

```typescript
  const plan: TurnPlan = {
    messages: buildDungeonMessages({
      settingText, state, input, dicePool,
      dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      intentsBlock, recallBlock,
    }),
    buildFastControl: (narrative) =>
      buildFastControlMessages({
        settingText, state, input, narrative, dicePool,
        dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      }),
    buildLoreSync: (narrative) =>
      buildLoreSyncMessages({
        settingText, state, input, narrative, dicePool,
        dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      }),
    appendRaw: (entry) => appendRun(deps.worldDir, active.dungeonId, active.runId, entry),
    rawFilePath: path.join(deps.worldDir, "dungeons", active.dungeonId, "runs", `${active.runId}.md`),
    dungeonId: active.dungeonId,
  };
```

- [ ] **Step 8: 重寫 `runLoreSync`（第 614-703 行）**

換成：

```typescript
async function runLoreSync(
  deps: TurnDeps,
  narrative: string,
  today: string,
  settingText: string,
  plan: TurnPlan,
  log: Logger,
): Promise<void> {
  try {
    const loreClient = deps.loreClient ?? deps.controlClient ?? deps.client;
    let raw = "";
    for await (const delta of loreClient.streamChat(plan.buildLoreSync(narrative))) {
      raw += delta;
    }
    const sync = parseLoreSyncOutput(raw);
    const changes = sync.state_changes;

    const entities = changes.touched_entities ?? [];
    const entityResults = await Promise.all(entities.map((e) => rewriteLoreEntity(deps, settingText, e, log)));

    let dungeonResult: LoreRewriteResult | null = null;
    if (changes.dungeon_wiki_excerpt && plan.dungeonId) {
      const rewriteClient = deps.loreClient ?? deps.controlClient ?? deps.client;
      const existing = await loadDungeonLore(deps.worldDir, plan.dungeonId, log);
      const title = `副本 ${plan.dungeonId} · 已揭露知識（Wiki）`;
      const content = await callLoreRewrite(rewriteClient, settingText, changes.dungeon_wiki_excerpt, title, existing.wiki);
      if (content) dungeonResult = { id: plan.dungeonId, category: "dungeon", title, content };
    }

    const results = [
      ...entityResults.filter((r): r is LoreRewriteResult => r !== null),
      ...(dungeonResult ? [dungeonResult] : []),
    ];

    for (const r of results) {
      if (r.category === "npc") {
        const existed = Boolean(await readBestEffort(path.join(deps.worldDir, "characters", `${r.id}.md`)));
        await rewriteNpcFile(deps.worldDir, r.id, r.content, log);
        if (!existed) {
          const indexPath = path.join(deps.worldDir, "characters", "index.md");
          const indexMd = await readBestEffort(indexPath);
          if (indexMd) await writeFile(indexPath, addCharacterIndexRow(indexMd, r.id, r.title), "utf8");
        }
      } else {
        const category = r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category];
        await rewriteLoreWiki(deps.worldDir, category, r.id, r.content, r.title, log);
      }
    }

    const npcIds = results.filter((r) => r.category === "npc").map((r) => r.id);
    if (npcIds.length > 0) await syncCharacterIndexStatus(deps, npcIds, log);

    if (deps.recall) {
      const touched: string[] = results.map((r) =>
        r.category === "npc"
          ? path.join(deps.worldDir, "characters", `${r.id}.md`)
          : path.join(loreDir(deps.worldDir, r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category], r.id), "wiki.md"),
      );
      if (npcIds.length > 0) touched.push(path.join(deps.worldDir, "characters", "index.md"));
      if (touched.length > 0) await reindexTouchedFiles(deps.recall, deps.worldDir, touched, log);
    }

    if (results.length > 0) {
      const committed = await deps.commit("補完關聯文件（NPC/道具/場景/技能）");
      log.info({ committed }, "回合結束（Layer 3 reactive-lore-sync）");
    } else {
      log.debug("Layer 3 reactive-lore-sync 本回合無 lore 異動，跳過 commit");
    }
  } catch (err) {
    log.warn({ err }, "Layer 3 reactive-lore-sync 失敗，本回合 lore 文件可能未完整補上");
  }
}
```

- [ ] **Step 9: 跑全部測試確認通過**

Run: `cd app && npx vitest run src/engine/turn.test.ts`
Expected: PASS（全部 it 綠燈）

- [ ] **Step 10: 跑型別檢查**

Run: `cd app && npx tsc --noEmit`
Expected: 無錯誤（確認沒有殘留對 `appendNpcUpdates`/`appendLoreReveals`/`appendWikiReveals`/`applyLorePickups`/`distill`/`wikiFilePath` 的引用）

- [ ] **Step 11: Commit**

```bash
git add app/src/engine/turn.ts app/src/engine/turn.test.ts
git commit -m "refactor(engine): Layer 3 runLoreSync 改用 touched_entities 整檔重寫，移除 append 分支"
```

---

### Task 7: 全量驗證

**Files:** 無新改動，純驗證。

- [ ] **Step 1: 跑全部測試**

Run: `cd app && npm test`
Expected: 全部 test file PASS（包含 `server/app.test.ts` 等未直接改動但可能間接受影響的檔案）

- [ ] **Step 2: 跑型別檢查與 build**

Run: `cd app && npx tsc --noEmit && npm run build`
Expected: 無錯誤，build 成功

- [ ] **Step 3: 確認沒有殘留死程式碼**

Run: `cd app && grep -rn "appendNpcUpdates\|appendLoreReveals\|appendWikiReveals\|applyLorePickups\|wiki_reveals\|item_pickups\|item_reveals\|location_pickups\|location_reveals\|skill_pickups\|skill_reveals\|npc_updates" src/`
Expected: 無輸出（全部舊欄位/函式名稱已清除）

- [ ] **Step 4: 若全部通過，無需額外 commit（Task 6 已是最終狀態）；若有殘留修正，修正後另開一個 commit**

```bash
git add -A
git commit -m "chore(engine): 清理 Layer 3 重寫後殘留的死程式碼" # 僅在 Step 3 有發現殘留時才需要
```

---

## Self-Review 摘要（已套用進上述內容）

- **Spec 覆蓋**：schema（Task 1）、lore.ts 整檔覆寫（Task 2）、dungeon.ts 連帶清理（Task 3）、NPC 角色檔整檔覆寫 + 新角色掛 index（Task 4）、prompt 文字（Task 5）、核心 `runLoreSync`/`rewriteLoreEntity`/`callLoreRewrite`/`TurnPlan`（Task 6）、回歸驗證（Task 7）——對話中討論的每一項（touched_entities 取代分散欄位、整檔重寫取代 append、secrets 生成時機不變、dungeon wiki 走固定 id、index.md 新角色掛載）都有對應 Task。
- **型別一致性**：`LoreEntityRef`（schema.ts）→ `rewriteLoreEntity` 參數 → `LoreRewriteResult` 全程用同一組 `category` 字面值 `"npc" | "item" | "location" | "skill"`（+ dungeon 額外的 `"dungeon"`），`ENTITY_CATEGORY_TO_LORE`/`ENTITY_CATEGORY_TITLE` 兩個 map 的 key 集合與之對齊，已核對無漂移。
- **無佔位符**：每個 Step 都附完整可貼上的程式碼/測試/指令，沒有「之後補」或「同上」。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-layer3-lore-rewrite.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 我每個 Task 派一個全新 subagent 執行，task 之間做 review，迭代快
**2. Inline Execution** - 在目前這個 session 裡照 executing-plans 批次執行，checkpoint 時讓你過目

**Which approach？**
