# Scene Rename 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把引擎所有 `location` / `locations` 改名為 `scene` / `scenes`，與 `templates/scene.md`、`now.md` 欄位名稱一致。

**Architecture:** 這是純 rename/搜尋替換——無新邏輯、無新檔案。分兩個 task：(1) 核心型別與 lore 層，(2) turn 層與測試。兩個 task 都只動已知檔案，可依序執行。

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- TypeScript，無 `any`，`tsc --noEmit` 零錯誤
- 測試用 Vitest：`cd app && npx vitest run`，全套 314 tests 通過
- 函式語意不變，只改名稱：`"location"` → `"scene"`，`"locations"` → `"scenes"`
- `world/locations/` 目錄不存在，無資料遷移
- `templates/scene.md` 已存在且正確，不需修改
- Commit 訊息格式：`refactor: <描述>`

---

## 檔案對應

**Task 1 修改：**
- `app/src/engine/lore.ts:11` — `LoreCategory` 改 `"locations"` → `"scenes"`
- `app/src/engine/schema.ts:71` — category enum `"location"` → `"scene"`
- `app/src/engine/turn/lore-rewrite.ts` — 多處 `"location"` → `"scene"`，`"locations"` → `"scenes"`
- `app/src/engine/world-ops.ts` — 一處註解

**Task 2 修改：**
- `app/src/engine/turn/index.ts` — `existingLocationIds` → `existingSceneIds`；`"locations"` → `"scenes"`
- `app/src/engine/turn/lore-sync.ts` — `locationIds` → `sceneIds`；`"locations"` → `"scenes"`；Set key `location` → `scene`
- `app/src/engine/turn/prompts.ts` — 兩處 prompt 字串 `location` → `scene`

**Tests（Task 2）：**
- `app/src/engine/schema.test.ts` — `"location"` → `"scene"`
- `app/src/engine/lore.test.ts` — `"locations"` → `"scenes"`；路徑 `locations/` → `scenes/`
- `app/src/engine/world-ops.test.ts` — `seedDirtyWorld` 路徑 `locations/` → `scenes/`；斷言同步
- `app/src/engine/turn/lore-rewrite.test.ts` — `"location"` → `"scene"`
- `app/src/engine/turn/lore-sync-validate.test.ts` — Set key `location` → `scene`
- `app/src/engine/turn/prompts.test.ts` — prompt 字串 `location` → `scene`

---

## Task 1：核心型別與 lore-rewrite 層

**Files:**
- Modify: `app/src/engine/lore.ts:11`
- Modify: `app/src/engine/schema.ts:71`
- Modify: `app/src/engine/turn/lore-rewrite.ts:16,27,52,54,58,60,64,71`
- Modify: `app/src/engine/world-ops.ts`（一處註解）

**Interfaces:**
- Produces:
  - `LoreCategory = "dungeons" | "items" | "skills" | "scenes"`（lore.ts）
  - `category: z.enum(["npc", "item", "scene", "skill"])`（schema.ts）
  - `ENTITY_SECRETS_DESIGNER_ROLE: Record<"item" | "scene" | "skill", string>`（lore-rewrite.ts）
  - `ENTITY_CATEGORY_TO_LORE: Record<"item" | "scene" | "skill", LoreCategory>`（lore-rewrite.ts，值 `"scenes"`）
  - `ENTITY_CATEGORY_TITLE: Record<"item" | "scene" | "skill", string>`（lore-rewrite.ts）
  - `LoreRewriteCategory = "npc" | "item" | "scene" | "skill" | "dungeon"`（lore-rewrite.ts）
  - `LORE_REWRITE_CATEGORY_OUTLINE`（lore-rewrite.ts，key `scene` 取代 `location`）

- [ ] **Step 1: 確認基線測試通過**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run
```

Expected: 36 files / 314 tests passed

- [ ] **Step 2: 修改 `lore.ts` — LoreCategory**

在 `app/src/engine/lore.ts` 第 11 行，把：
```typescript
export type LoreCategory = "dungeons" | "items" | "skills" | "locations";
```
改為：
```typescript
export type LoreCategory = "dungeons" | "items" | "skills" | "scenes";
```

- [ ] **Step 3: 修改 `schema.ts` — category enum**

在 `app/src/engine/schema.ts` 第 71 行，把：
```typescript
  category: z.enum(["npc", "item", "location", "skill"]),
```
改為：
```typescript
  category: z.enum(["npc", "item", "scene", "skill"]),
```

- [ ] **Step 4: 修改 `lore-rewrite.ts` — 所有 location 改 scene**

在 `app/src/engine/turn/lore-rewrite.ts` 做以下替換：

```typescript
// 第 16 行：Record key 改 scene
export const ENTITY_SECRETS_DESIGNER_ROLE: Record<"item" | "scene" | "skill", string> = {
  item: "道具設計者",
  scene: "場景設計者",
  skill: "技能設計者",
};

// 第 27 行：generateEntitySecrets 參數型別改 scene
export async function generateEntitySecrets(
  client: LlmClient,
  settingText: string,
  entityName: string,
  category: "item" | "scene" | "skill",
  log: Logger,
): Promise<string> {

// 第 52-56 行：ENTITY_CATEGORY_TO_LORE 改 scene → "scenes"
export const ENTITY_CATEGORY_TO_LORE: Record<"item" | "scene" | "skill", LoreCategory> = {
  item: "items",
  scene: "scenes",
  skill: "skills",
};

// 第 58-62 行：ENTITY_CATEGORY_TITLE 改 scene
export const ENTITY_CATEGORY_TITLE: Record<"item" | "scene" | "skill", string> = {
  item: "道具",
  scene: "場景",
  skill: "技能",
};

// 第 64 行：LoreRewriteCategory 改 scene
export type LoreRewriteCategory = "npc" | "item" | "scene" | "skill" | "dungeon";

// 第 71 行：LORE_REWRITE_CATEGORY_OUTLINE key 改 scene
  scene: "- 地理/環境描述\n- 已知規則或機關（已揭露部分）\n- 已知危險與資源\n- 出沒生物或 NPC",
```

- [ ] **Step 5: 修改 `world-ops.ts` — 更新註解**

在 `app/src/engine/world-ops.ts` 找到這行註解（約第 180 行）：
```typescript
 * 檔案（NPC 檔、locations/、items/、journal_summary.md…）會殘留進新世界。
```
改為：
```typescript
 * 檔案（NPC 檔、scenes/、items/、journal_summary.md…）會殘留進新世界。
```

- [ ] **Step 6: 確認型別檢查通過**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx tsc --noEmit 2>&1 | head -30
```

Expected: 有錯誤（Task 2 還沒改 lore-sync/index/prompts 等呼叫端）。確認錯誤都是「找不到 `"location"` 這個值」類型，不是其他意外錯誤。

- [ ] **Step 7: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/lore.ts app/src/engine/schema.ts app/src/engine/turn/lore-rewrite.ts app/src/engine/world-ops.ts
git commit -m "refactor: LoreCategory/schema/lore-rewrite 的 location → scene"
```

---

## Task 2：turn 層、prompts、所有測試

**Files:**
- Modify: `app/src/engine/turn/index.ts`
- Modify: `app/src/engine/turn/lore-sync.ts`
- Modify: `app/src/engine/turn/prompts.ts`
- Modify: `app/src/engine/schema.test.ts`
- Modify: `app/src/engine/lore.test.ts`
- Modify: `app/src/engine/world-ops.test.ts`
- Modify: `app/src/engine/turn/lore-rewrite.test.ts`
- Modify: `app/src/engine/turn/lore-sync-validate.test.ts`
- Modify: `app/src/engine/turn/prompts.test.ts`

**Interfaces:**
- Consumes: Task 1 產出的 `LoreCategory`（含 `"scenes"`）、`LoreRewriteCategory`（含 `"scene"`）、`category` enum（含 `"scene"`）

- [ ] **Step 1: 修改 `turn/index.ts` — existingLocationIds → existingSceneIds**

在 `app/src/engine/turn/index.ts`，找到 `collectExistingEntityIds` 函式（約第 60–76 行）：

```typescript
// 舊版
async function collectExistingEntityIds(
  worldDir: string,
  state: GameState,
  log: Logger,
): Promise<{ existingNpcIds: string[]; existingItemIds: string[]; existingLocationIds: string[]; existingSkillIds: string[] }> {
  const [existingItemIds, existingLocationIds, existingSkillIds] = await Promise.all([
    listLoreIds(worldDir, "items", log),
    listLoreIds(worldDir, "locations", log),
    listLoreIds(worldDir, "skills", log),
  ]);
  return {
    existingNpcIds: state.npcs.map((n) => n.id),
    existingItemIds,
    existingLocationIds,
    existingSkillIds,
  };
}
```

改為：

```typescript
async function collectExistingEntityIds(
  worldDir: string,
  state: GameState,
  log: Logger,
): Promise<{ existingNpcIds: string[]; existingItemIds: string[]; existingSceneIds: string[]; existingSkillIds: string[] }> {
  const [existingItemIds, existingSceneIds, existingSkillIds] = await Promise.all([
    listLoreIds(worldDir, "items", log),
    listLoreIds(worldDir, "scenes", log),
    listLoreIds(worldDir, "skills", log),
  ]);
  return {
    existingNpcIds: state.npcs.map((n) => n.id),
    existingItemIds,
    existingSceneIds,
    existingSkillIds,
  };
}
```

同時找到呼叫 `collectExistingEntityIds` 結果的地方（`runMainSpaceTurn` 和 `runDungeonTurn`），把 `existingLocationIds` 改為 `existingSceneIds`（spread 進 `buildLoreSyncMessages` 的參數）。

- [ ] **Step 2: 修改 `turn/lore-sync.ts` — locationIds → sceneIds，Set key**

在 `app/src/engine/turn/lore-sync.ts` 約第 97–115 行：

```typescript
// 舊版
const [itemIds, locationIds, skillIds] = await Promise.all([
  listLoreIds(deps.worldDir, "items", log),
  listLoreIds(deps.worldDir, "locations", log),
  listLoreIds(deps.worldDir, "skills", log),
]);
// ...
const entities = reconcileEntityCategories(
  sanitized,
  {
    npc: new Set(npcEntries.map((n) => n.id)),
    item: new Set(itemIds),
    location: new Set(locationIds),
    skill: new Set(skillIds),
  },
  log,
  npcNameToId,
);
```

改為：

```typescript
const [itemIds, sceneIds, skillIds] = await Promise.all([
  listLoreIds(deps.worldDir, "items", log),
  listLoreIds(deps.worldDir, "scenes", log),
  listLoreIds(deps.worldDir, "skills", log),
]);
// ...
const entities = reconcileEntityCategories(
  sanitized,
  {
    npc: new Set(npcEntries.map((n) => n.id)),
    item: new Set(itemIds),
    scene: new Set(sceneIds),
    skill: new Set(skillIds),
  },
  log,
  npcNameToId,
);
```

同時更新同檔案頂部的 JSDoc 註解（第 72 行）：
```typescript
 * Layer 3（reactive-lore-sync）：讀主腦敘事，抽出 npc/item/scene/skill/wiki 的延後落地欄位。
```

- [ ] **Step 3: 修改 `turn/prompts.ts` — prompt 字串**

在 `app/src/engine/turn/prompts.ts`，找到兩處 `location`：

**第一處**（約第 52 行，LORE_SYNC_FORMAT_BLOCK）：
```typescript
"    category 只能是 npc/item/location/skill 其中之一；id 用小寫英數 slug，單字以底線分隔（snake_case）；",
```
改為：
```typescript
"    category 只能是 npc/item/scene/skill 其中之一；id 用小寫英數 slug，單字以底線分隔（snake_case）；",
```

**第二處**（約第 205 行，JSDoc 註解）：
```typescript
 * npc/item/location/skill/wiki 等可延後落地的欄位交給 buildLoreSyncMessages。
```
改為：
```typescript
 * npc/item/scene/skill/wiki 等可延後落地的欄位交給 buildLoreSyncMessages。
```

- [ ] **Step 4: 更新 `schema.test.ts`**

在 `app/src/engine/schema.test.ts`，把三處 `"location"` 改為 `"scene"`：

```typescript
// 約第 129 行 it 描述
it("接受 touched_entities（npc/item/scene/skill）與 dungeon_wiki_excerpt", () => {

// 約第 135 行 entity 物件
{ id: "info-room", category: "scene", name: "資訊室", excerpt: "資訊室牆上有監視器。" },

// 約第 145 行 期望值
{ id: "info-room", category: "scene", name: "資訊室", excerpt: "資訊室牆上有監視器。" },

// 約第 151 行 it 描述（category 的錯誤測試）
it("category 不在 npc/item/scene/skill 之中時拋錯", () => {
```

- [ ] **Step 5: 更新 `lore.test.ts`**

在 `app/src/engine/lore.test.ts`，把所有 `"locations"` 改為 `"scenes"`，`locations/` 路徑改為 `scenes/`：

```typescript
// 約第 60-61 行
await rewriteLoreWiki(world, "scenes", "panel", "### 地理/環境描述\n\n面板設於角落。", "場景（panel）");
const wiki = await readFile(path.join(world, "scenes", "panel", "wiki.md"), "utf8");

// 約第 75 行 it 描述
it("scenes 分類沿用同一套規則", async () => {

// 約第 76-78 行
await ensureSecrets(world, "scenes", "info-room", "牆後藏了監聽器", "title");
await rewriteLoreWiki(world, "scenes", "info-room", "牆上有一面鏡子", "title");
const lore = await loadLore(world, "scenes", "info-room");
```

- [ ] **Step 6: 更新 `world-ops.test.ts` — seedDirtyWorld 路徑**

在 `app/src/engine/world-ops.test.ts`，把 `seedDirtyWorld` 函式裡的路徑從 `locations` 改為 `scenes`：

```typescript
// 約第 42 行
await mkdir(path.join(worldDir, "scenes", "iron_gate"), { recursive: true });

// 約第 54 行
await writeFile(path.join(worldDir, "scenes", "iron_gate", "wiki.md"), "# 鐵門\n", "utf8");

// 約第 68 行 it 描述
it("清掉所有動態長出的殘留（NPC/scenes/items/journal_summary），只留佔位檔", async () => {

// 約第 109、111 行 斷言
expect(archivedFiles).toContain("scenes/iron_gate/wiki.md");
// 還有 it 描述文字（第 109 行附近）
// 1) archive 完整保留舊世界（含 scenes/items/NPC）
```

- [ ] **Step 7: 更新 `lore-rewrite.test.ts`**

在 `app/src/engine/turn/lore-rewrite.test.ts`，把 `"location"` 改為 `"scene"`：

```typescript
// 約第 46 行
["scene", "已知規則或機關"],

// 約第 73-75 行
["scene", "場景設計者", "場景名稱"],
// ...
] as [("item" | "scene" | "skill"), string, string][])(
```

- [ ] **Step 8: 更新 `lore-sync-validate.test.ts`**

在 `app/src/engine/turn/lore-sync-validate.test.ts` 約第 97 行，把 Set key 改為 `scene`：

```typescript
const empty = { npc: new Set<string>(), item: new Set<string>(), scene: new Set<string>(), skill: new Set<string>() };
```

同時搜尋同檔案是否還有其他 `location` 出現，一併改為 `scene`。

- [ ] **Step 9: 更新 `prompts.test.ts`**

在 `app/src/engine/turn/prompts.test.ts` 約第 149 行，把斷言字串改為 `scene`：

```typescript
expect(msgs[0].content).toContain("npc/item/scene/skill");
```

- [ ] **Step 10: 確認 `lore-sync-validate.ts` 的 ExistingEntitySets 型別**

搜尋 `lore-sync-validate.ts` 是否有 `location` key 的型別定義：

```bash
grep -n "location\|scene" /Users/kk/projects/Inifinity-world-adventure/app/src/engine/turn/lore-sync-validate.ts
```

若有 `location:` 欄位，改為 `scene:`。

- [ ] **Step 11: 執行全套測試**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run
```

Expected: 36 files / 314 tests passed

- [ ] **Step 12: 型別檢查**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx tsc --noEmit
```

Expected: 零錯誤

- [ ] **Step 13: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/turn/index.ts \
        app/src/engine/turn/lore-sync.ts \
        app/src/engine/turn/prompts.ts \
        app/src/engine/schema.test.ts \
        app/src/engine/lore.test.ts \
        app/src/engine/world-ops.test.ts \
        app/src/engine/turn/lore-rewrite.test.ts \
        app/src/engine/turn/lore-sync-validate.test.ts \
        app/src/engine/turn/prompts.test.ts
git commit -m "refactor: turn 層與所有測試的 location → scene 完成 rename"
```

---

## 自審 Checklist

**Spec 覆蓋：**
- [x] `LoreCategory` `"locations"` → `"scenes"` — Task 1
- [x] schema category enum `"location"` → `"scene"` — Task 1
- [x] `lore-rewrite.ts` 所有 Record/type 改名 — Task 1
- [x] `turn/index.ts` `existingLocationIds` → `existingSceneIds` — Task 2
- [x] `lore-sync.ts` `locationIds` → `sceneIds`，Set key — Task 2
- [x] `prompts.ts` 兩處 prompt 字串 — Task 2
- [x] 全部 6 個測試檔案更新 — Task 2
- [x] `lore-sync-validate.ts` ExistingEntitySets key — Task 2 Step 10

**Placeholder 掃描：** 無 TBD/TODO

**型別一致性：**
- `LoreRewriteCategory` 在 Task 1 改為含 `"scene"`；`lore-sync.ts` 的 Set 物件 key 在 Task 2 改為 `scene`，兩邊對齊
- `ENTITY_CATEGORY_TO_LORE` 在 Task 1 值改為 `"scenes"`；`listLoreIds(worldDir, "scenes", ...)` 在 Task 2 對齊
