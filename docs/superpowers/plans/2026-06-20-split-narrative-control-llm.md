# 拆分主敘事與結構控制輸出（雙腦回合）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每回合單一 LLM call（同時吐敘事散文 + `===STATE===` JSON）拆成兩次循序呼叫：主腦只寫純散文，副大腦讀完整散文後抽出完整 `TurnControl` JSON。

**Architecture:** `runTurnCore` 先串流主腦的純敘事（直接轉發 delta，不再做 sentinel 切分），取得完整敘事後再呼叫可獨立設定的「副大腦」client（`deps.controlClient`，未設定退回 `deps.client`），輸入完整敘事 + canonical 狀態 + 骰池（+ 副本 wiki/secrets +現有副本 id 列表），輸出整段就是一個 JSON 物件，走既有 `TurnControlSchema` 驗證。副大腦失敗時降級：敘事已落地，`now.md` 只 bump 時間戳、不套狀態、`awaiting_user_input=true`、發 warning。

**Tech Stack:** Node.js + TypeScript、Zod（既有 `TurnControlSchema`）、Vitest、Fastify（既有 SSE 路由）、OpenAI 相容串流 client。

## Global Constraints

- 全程繁體中文與台灣用詞（程式碼註解、prompt 文案沿用倉庫既有風格）。
- 不可變更 `TurnControlSchema`（`schema.ts`）的欄位定義。
- 不改變擲骰機制：骰池仍由 `engine/roll.ts`（crypto 真隨機）伺服器端預擲，餵進主腦；副大腦不重新擲骰，只從敘事抽取已用骰值成 `rolls[]`。
- 不改變 raw 層落地（`journal.ts`/`dungeon.ts`）、`now.md` 覆寫、積分增減、wiki 提煉、commit 的下游邏輯與時機，只改「結構從哪來」。
- 不引入第三個 LLM agent；`mode_transition`/`transition_dungeon_id` 是副大腦輸出 `TurnControl` 的欄位之一。
- `character-pre-pass.ts` 維持原樣，不在本計畫範圍。
- LLM 端點/金鑰/模型一律走 `app/.env`；前端不提供改後端端點的介面。
- 不可使用 `any`（用 `unknown` + 收窄）；不可留 `console.log`（用 `logger`）。
- 測試環境（`NODE_ENV=test`）logger 為 silent，測試以 fake client 注入。
- 工作目錄：所有指令在 `app/` 下執行（`cd /Users/kk/projects/Inifinity-world-adventure/app`）。

---

## File Structure

- `src/engine/schema.ts` — 移除 `parseTurnOutput`（敘事+sentinel+JSON 一體），新增 `parseControlOutput`（整段視為 JSON，無 sentinel）。`TurnControlSchema` 不動。
- `src/engine/schema.test.ts` — 改測 `parseControlOutput`。
- `src/engine/dungeon.ts` — 新增 `listDungeonIds(worldDir)`，列舉 `dungeons/` 子目錄名（供副大腦判斷 `enter_dungeon` 續用既有 slug）。
- `src/engine/dungeon.test.ts` — 加 `listDungeonIds` 測試。
- `src/engine/turn.ts` — 主腦 prompt 移除 JSON 輸出要求；新增 `buildControlMessages` 與 `requestControl`；`runTurnCore` 改為兩段呼叫（主腦串流純散文 → 副大腦抽 JSON → 降級處理）；移除 `createNarrativeSplitter` 使用。
- `src/engine/turn.test.ts` — mock 改為主腦回純散文、副大腦回 JSON 兩段。
- `src/engine/stream-split.ts` + `src/engine/stream-split.test.ts` — 刪除（不再有非測試呼叫點；`STATE_SENTINEL` 隨之移除）。
- `src/config.ts` + `src/config.test.ts` — 新增 `control?: { baseUrl; model }` 與對應環境變數。
- `src/server/app.ts` — 啟動時建立 `controlClient` 並傳入 `runTurnLoop`。
- `.env.example` — 新增副大腦設定範例。

---

## Task 1: config 新增副大腦（control）後端設定

**Files:**
- Modify: `src/config.ts:24-28`（`AppConfig.character` 之後加 `control`）、`src/config.ts:72-78`（`loadConfig` 解析）
- Modify: `.env.example`（尾端加區塊）
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: 既有 `AppConfig`、`loadConfig(env)`。
- Produces: `AppConfig.control?: { baseUrl: string; model: string }`，由 `CONTROL_OPENAI_BASE_URL` + `CONTROL_MODEL` 兩者皆設定時才有值（與 `character` 同模式）。

- [ ] **Step 1: 寫失敗測試**

在 `src/config.test.ts` 的 `describe("loadConfig"...)` 區塊內，`character` 兩個測試之後加入：

```typescript
  it("control 欄位：有設定時解析", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1",
      OPENAI_API_KEY: "key",
      MODEL: "main-model",
      CONTROL_OPENAI_BASE_URL: "http://ctrl/v1",
      CONTROL_MODEL: "qwen2.5:7b",
    });
    expect(config.control).toEqual({
      baseUrl: "http://ctrl/v1",
      model: "qwen2.5:7b",
    });
  });

  it("control 欄位：未設定時為 undefined", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1",
      OPENAI_API_KEY: "key",
      MODEL: "main-model",
    });
    expect(config.control).toBeUndefined();
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/config.test.ts`
Expected: FAIL（`config.control` 為 undefined，第一個新測試的 `toEqual` 不符）

- [ ] **Step 3: 實作**

在 `src/config.ts` 的 `AppConfig` interface，`character?: {...}` 區塊之後加入：

```typescript
  /** 結構控制抽取 LLM（副大腦，選填）；缺省時 engine 沿用主 client */
  control?: {
    baseUrl: string;
    model: string;
  };
```

在 `loadConfig` return 物件，`character: ...` 之後加入：

```typescript
    control:
      env.CONTROL_OPENAI_BASE_URL && env.CONTROL_MODEL
        ? {
            baseUrl: env.CONTROL_OPENAI_BASE_URL,
            model: env.CONTROL_MODEL,
          }
        : undefined,
```

在 `.env.example` 尾端（`CHARACTER_MODEL` 那行之後）加入：

```bash

# 結構控制抽取 LLM（副大腦，選填；缺省沿用主 LLM）
# 主敘事用大模型衝文筆，副大腦可用小/快模型專心抽結構化 JSON
# CONTROL_OPENAI_BASE_URL=http://localhost:11434/v1
# CONTROL_MODEL=qwen2.5:7b
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app
git add src/config.ts src/config.test.ts .env.example
git commit -m "feat(config): 新增副大腦（control）LLM 後端設定"
```

---

## Task 2: schema 新增 parseControlOutput（取代 parseTurnOutput）

**Files:**
- Modify: `src/engine/schema.ts`（移除 `import STATE_SENTINEL`、`ParsedTurn`、`parseTurnOutput`；新增 `parseControlOutput`）
- Test: `src/engine/schema.test.ts`（整檔改寫）

**Interfaces:**
- Consumes: 既有 `TurnControlSchema`、`TurnControl` 型別。
- Produces: `parseControlOutput(raw: string): TurnControl` —— 從副大腦原始輸出抓第一個 `{` 到最後一個 `}` 之間的內容當 JSON 解析，再走 `TurnControlSchema.parse`。找不到 JSON、JSON 非法、或 schema 不符都拋 `Error`。

- [ ] **Step 1: 改寫測試**

把 `src/engine/schema.test.ts` 整檔換成：

```typescript
import { describe, it, expect } from "vitest";
import { parseControlOutput } from "./schema.js";

const VALID = `{
  "state_changes": { "now": { "scene": "資訊室", "nextStep": "找葉晴談戰術" }, "protagonist_points_delta": 0 },
  "rolls": [],
  "mode_transition": null,
  "awaiting_user_input": true,
  "suggested_actions": ["找葉晴", "回休息區"],
  "commit_summary": "沈奕前往資訊室"
}`;

describe("parseControlOutput", () => {
  it("解析整段 JSON 並通過 schema 驗證", () => {
    const control = parseControlOutput(VALID);
    expect(control.awaiting_user_input).toBe(true);
    expect(control.suggested_actions).toEqual(["找葉晴", "回休息區"]);
    expect(control.commit_summary).toBe("沈奕前往資訊室");
    expect(control.state_changes.now?.scene).toBe("資訊室");
    expect(control.mode_transition).toBeNull();
  });

  it("容忍 JSON 前後有雜訊文字（抓第一個 { 到最後一個 }）", () => {
    const control = parseControlOutput(
      '這是控制區塊：\n{"awaiting_user_input":false,"commit_summary":"x"}\n以上。',
    );
    expect(control.awaiting_user_input).toBe(false);
    expect(control.commit_summary).toBe("x");
  });

  it("找不到 JSON 物件時拋錯", () => {
    expect(() => parseControlOutput("完全沒有大括號")).toThrow();
  });

  it("JSON 非法時拋錯", () => {
    expect(() => parseControlOutput("{not json}")).toThrow();
  });

  it("缺必要欄位 awaiting_user_input 時拋錯", () => {
    expect(() => parseControlOutput('{"commit_summary":"x"}')).toThrow();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/schema.test.ts`
Expected: FAIL（`parseControlOutput` 尚未匯出）

- [ ] **Step 3: 實作**

在 `src/engine/schema.ts`：刪除第 2 行 `import { STATE_SENTINEL } from "./stream-split.js";`，並把 `ParsedTurn` interface 與 `parseTurnOutput` 函式（第 54-87 行）整段換成：

```typescript
/**
 * 從副大腦原始輸出解析出 TurnControl。
 * 副大腦只負責輸出結構，整段視為一個 JSON 物件（無 sentinel）；
 * 為容忍模型偶爾前後加客套字，抓第一個 `{` 到最後一個 `}` 之間當 JSON。
 * 找不到 JSON / JSON 非法 / schema 不符都拋錯（由呼叫端決定降級）。
 */
export function parseControlOutput(raw: string): TurnControl {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("副大腦輸出找不到 JSON 物件");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`副大腦輸出 JSON 解析失敗：${(e as Error).message}`);
  }

  return TurnControlSchema.parse(parsed);
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/schema.test.ts`
Expected: PASS

注意：此時 `turn.ts` 仍 import `parseTurnOutput`，全專案 typecheck/build 會壞——這是預期的，Task 5 會修。本步驟只確認 schema 單檔測試通過。

- [ ] **Step 5: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app
git add src/engine/schema.ts src/engine/schema.test.ts
git commit -m "feat(schema): 以 parseControlOutput 取代 parseTurnOutput（副大腦無 sentinel）"
```

---

## Task 3: dungeon 新增 listDungeonIds

**Files:**
- Modify: `src/engine/dungeon.ts`（新增匯出函式）
- Test: `src/engine/dungeon.test.ts`

**Interfaces:**
- Consumes: 既有 `node:fs/promises` 的 `readdir`（已 import 於 `dungeon.ts:1`）、`logUnexpectedReadError`。
- Produces: `listDungeonIds(worldDir: string, logger?: Logger): Promise<string[]>` —— 回傳 `world/dungeons/` 下所有子目錄名（副本 id）。`dungeons/` 不存在時回 `[]`。

- [ ] **Step 1: 寫失敗測試**

在 `src/engine/dungeon.test.ts` 檔尾（最後一個 `describe` 之後）加入：

```typescript
describe("listDungeonIds", () => {
  let world: string;
  beforeEach(async () => {
    world = await mkdtemp(path.join(tmpdir(), "iwa-listdg-"));
  });
  afterEach(async () => {
    await rm(world, { recursive: true, force: true });
  });

  it("dungeons/ 不存在時回空陣列", async () => {
    expect(await listDungeonIds(world)).toEqual([]);
  });

  it("回傳所有副本子目錄名，忽略檔案", async () => {
    await enterDungeon(world, { dungeonId: "U-001", today: "d", protagonistSummary: "x", goal: "g", secretsText: "s" });
    await enterDungeon(world, { dungeonId: "abandoned-hospital", today: "d", protagonistSummary: "x", goal: "g", secretsText: "s" });
    const ids = await listDungeonIds(world);
    expect(ids.sort()).toEqual(["U-001", "abandoned-hospital"]);
  });
});
```

並把檔案頂部的 import 補上 `listDungeonIds`（第 5-13 行的 import 區塊內加一行）：

```typescript
  listDungeonIds,
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/dungeon.test.ts`
Expected: FAIL（`listDungeonIds` 未匯出）

- [ ] **Step 3: 實作**

在 `src/engine/dungeon.ts` 檔尾加入：

```typescript
/** 列舉 world/dungeons/ 下所有副本子目錄名（id）；dungeons/ 不存在回 [] */
export async function listDungeonIds(
  worldDir: string,
  logger: Logger = defaultLogger,
): Promise<string[]> {
  const dir = path.join(worldDir, "dungeons");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    logUnexpectedReadError(logger, dir, err);
    return [];
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/dungeon.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app
git add src/engine/dungeon.ts src/engine/dungeon.test.ts
git commit -m "feat(dungeon): 新增 listDungeonIds 列舉現有副本 id"
```

---

## Task 4: turn.ts — 主腦 prompt 去 JSON、新增副大腦 prompt 建構

**Files:**
- Modify: `src/engine/turn.ts`（改 `OUTPUT_FORMAT_BLOCK`、`buildMainSpaceMessages`/`buildDungeonMessages` 措辭；新增 `buildControlMessages`）
- Test: `src/engine/turn.test.ts`（`buildMainSpaceMessages` describe 區塊；新增 `buildControlMessages` describe）

**Interfaces:**
- Consumes: 既有 `BuildMessagesParams`、`canonicalBlock`、`GameState`、`ChatMessage`。
- Produces:
  - `buildMainSpaceMessages` / `buildDungeonMessages`：行為不變的簽章，但 system prompt 不再含 `===STATE===`/JSON 欄位說明，骰值措辭改為「敘事中要把用到的骰值與成敗寫清楚」。
  - `CONTROL_FORMAT_BLOCK: string`（模組內常數，描述副大腦要輸出的 JSON 欄位）。
  - `buildControlMessages(params: BuildControlParams): ChatMessage[]`，其中
    ```typescript
    export interface BuildControlParams {
      settingText: string;
      state: GameState;
      input: string;
      narrative: string;
      dicePool: number[];
      existingDungeonIds: string[];
      // 副本模式才填：
      dungeonId?: string;
      wiki?: string;
      secrets?: string;
    }
    ```

- [ ] **Step 1: 改寫主腦 prompt 測試**

把 `src/engine/turn.test.ts` 中 `describe("buildMainSpaceMessages"...)` 的第一個測試（`it("system 含設定、canonical、輸出格式與骰值..."`）換成：

```typescript
  it("system 含設定、canonical 與骰值，但不再含 JSON 輸出要求", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "禁止竄改數值。", state: sampleState, input: "我四處看看", dicePool: [7, 42],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁止竄改數值");
    expect(msgs[0].content).toContain("[7, 42]");
    expect(msgs[0].content).not.toContain("===STATE===");
    expect(msgs[0].content).not.toContain("awaiting_user_input");
    expect(msgs[1]).toEqual({ role: "user", content: "我四處看看" });
  });
```

（同 describe 內 `intentsBlock` 的兩個測試不動。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/turn.test.ts -t "不再含 JSON"`
Expected: FAIL（目前 system 仍含 `===STATE===`）

- [ ] **Step 3: 改主腦 prompt 實作**

在 `src/engine/turn.ts`，把 `OUTPUT_FORMAT_BLOCK` 常數（第 72-83 行）整段刪除，改新增一個給副大腦用的常數：

```typescript
const CONTROL_FORMAT_BLOCK = [
  "## 輸出格式（務必嚴格遵守）",
  "只輸出**單一 JSON 物件**，不要任何前言、後語或程式碼框。欄位：",
  "- state_changes: { now?: {七欄任意子集，鍵用 chapter/scene/companions/activeDungeon/threads/nextStep},",
  "    protagonist_points_delta?: number, npc_updates?: [{id, update}], wiki_reveals?: [string] }",
  "- rolls: [{desc, value, success?}]（敘事中實際用到的骰值與判定，沒有就空陣列）",
  '- mode_transition: null | "enter_dungeon" | "settle_dungeon"',
  "- transition_dungeon_id / transition_dungeon_goal：配合 enter_dungeon 才填",
  "- awaiting_user_input: boolean —— 敘事屬純環境/系統旁白/NPC 自行動作、玩家不需做決定時設 false；需要玩家選擇才設 true。",
  "- suggested_actions: string[]、commit_summary: string（一句摘要）",
].join("\n");
```

把 `buildMainSpaceMessages`（第 108-136 行）system 陣列中的這幾行：

```typescript
    "- 需要機率判定時，**只能依序取用下方『本回合骰值』**，不可自行編造數字；用到的骰值要在 rolls 回報。",
    "",
    OUTPUT_FORMAT_BLOCK,
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
```

換成：

```typescript
    "- 需要機率判定時，**只能依序取用下方『本回合骰值』**，不可自行編造數字；用到的骰值與成敗要寫進敘事，後續由系統自動抽取。",
    "",
    "## 輸出格式",
    "只輸出要顯示給玩家的敘事散文，不要輸出任何 JSON 或控制區塊；結構化狀態由系統另行處理。",
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
```

把 `buildDungeonMessages`（第 145-179 行）system 陣列中的：

```typescript
    "- 機率判定**只能依序取用下方骰值**，用到要在 rolls 回報。",
    "- 副本達主線目標/死亡/撤退時，把 mode_transition 設為 settle_dungeon。",
    "",
    OUTPUT_FORMAT_BLOCK,
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
```

換成：

```typescript
    "- 機率判定**只能依序取用下方骰值**，用到的骰值與成敗要寫進敘事，後續由系統自動抽取。",
    "- 副本達主線目標/死亡/撤退時，在敘事中明確呈現該轉折（系統會據此結算）。",
    "",
    "## 輸出格式",
    "只輸出要顯示給玩家的敘事散文，不要輸出任何 JSON 或控制區塊；結構化狀態由系統另行處理。",
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
```

- [ ] **Step 4: 新增 buildControlMessages 測試**

在 `src/engine/turn.test.ts` 頂部 import 補上 `buildControlMessages`（第 8 行的 import 清單內加入），並在 `describe("buildMainSpaceMessages"...)` 之後新增：

```typescript
describe("buildControlMessages", () => {
  it("主空間：system 含敘事、骰值、現有副本 id；user 帶玩家行動", () => {
    const msgs = buildControlMessages({
      settingText: "設定", state: sampleState, input: "我四處看看",
      narrative: "沈奕走進資訊室，擲出 42 成功避開警衛。",
      dicePool: [42, 7], existingDungeonIds: ["U-001", "abandoned-hospital"],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("awaiting_user_input");
    expect(msgs[0].content).toContain("[42, 7]");
    expect(msgs[0].content).toContain("U-001");
    expect(msgs[0].content).toContain("abandoned-hospital");
    expect(msgs[0].content).toContain("沈奕走進資訊室");
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("我四處看看");
  });

  it("副本：system 額外帶 wiki 與 dungeonId，且不外洩 secrets 段標題以外內容給玩家由副大腦自行判斷", () => {
    const msgs = buildControlMessages({
      settingText: "設定", state: sampleState, input: "往前走",
      narrative: "你抵達出口。", dicePool: [5], existingDungeonIds: ["U-001"],
      dungeonId: "U-001", wiki: "入口有三道門", secrets: "地板會塌",
    });
    expect(msgs[0].content).toContain("U-001");
    expect(msgs[0].content).toContain("入口有三道門");
  });
});
```

- [ ] **Step 5: 跑測試確認失敗**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/turn.test.ts -t "buildControlMessages"`
Expected: FAIL（`buildControlMessages` 未匯出）

- [ ] **Step 6: 實作 buildControlMessages**

在 `src/engine/turn.ts`，緊接在 `buildDungeonMessages` 之後加入：

```typescript
export interface BuildControlParams {
  settingText: string;
  state: GameState;
  input: string;
  /** 主腦本回合已產生的完整敘事散文 */
  narrative: string;
  dicePool: number[];
  /** 現有副本 id 列表，供 enter_dungeon 判斷續用既有 slug 或新建 */
  existingDungeonIds: string[];
  /** 副本模式才填 */
  dungeonId?: string;
  wiki?: string;
  secrets?: string;
}

/**
 * 副大腦（結構控制抽取）的對話訊息：讀主腦寫好的敘事 + 當前狀態，
 * 抽出 TurnControl JSON。只整理敘事中已發生的事實，不得新增劇情或發明數值。
 */
export function buildControlMessages(params: BuildControlParams): ChatMessage[] {
  const { settingText, state, input, narrative, dicePool, existingDungeonIds } = params;
  const inDungeon = Boolean(params.dungeonId);
  const system = [
    "你是本世界敘事引擎的**結構控制抽取器**。",
    "下方有本回合已經產生的敘事散文，你的工作是把其中**已經發生的事實**整理成結構化 JSON。",
    "",
    "## 鐵則",
    "- 只整理敘事中已經寫出的事實，**不可新增劇情、不可發明敘事未提及的數值或事件**。",
    "- protagonist_points_delta 只反映敘事中明確發生的積分增減；沒寫到就填 0 或省略。",
    "- rolls 只回報敘事中實際用到的骰值（對照下方骰池），沒有就空陣列。",
    inDungeon
      ? "- 副本達主線目標/主角死亡/撤退離開時，mode_transition 設為 settle_dungeon。"
      : "- 敘事中若系統強制開啟/傳送進副本，mode_transition 設為 enter_dungeon，並填 transition_dungeon_id：" +
        "優先比對下方『現有副本 id』判斷是否重返既有副本；若是全新副本才生成新的 kebab-case 短 slug。",
    "",
    CONTROL_FORMAT_BLOCK,
    "",
    `## 本回合骰值（d100，主腦依序取用）：[${dicePool.join(", ")}]`,
    "",
    `## 現有副本 id（供判斷續用/新建）：${existingDungeonIds.length > 0 ? existingDungeonIds.join("、") : "（無）"}`,
    "",
    "## 世界設定",
    settingText.trim(),
    "",
    ...(inDungeon
      ? ["## 副本已揭露知識（wiki）", (params.wiki ?? "").trim() || "（尚無）",
         "", `## 當前副本 id：${params.dungeonId}`, ""]
      : []),
    canonicalBlock(state),
    "",
    "## 本回合敘事散文（事實來源）",
    narrative.trim(),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: `玩家本回合行動：${input}` },
  ];
}
```

> 註：`secrets` 列在 `BuildControlParams` 以對齊 `buildDungeonMessages` 的傳參形狀，但副大腦只做事實抽取、不需要暗線，故不注入 secrets，避免劇透洩漏進結構層。

- [ ] **Step 7: 跑測試確認通過**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/turn.test.ts -t "buildControlMessages"`
Expected: PASS（`buildControlMessages` 兩個測試通過）

注意：此時 `runTurnCore` 仍用 `parseTurnOutput`/`createNarrativeSplitter`，`turn.test.ts` 其他測試與 typecheck 仍會壞——Task 5 修。

- [ ] **Step 8: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app
git add src/engine/turn.ts src/engine/turn.test.ts
git commit -m "feat(turn): 主腦 prompt 去 JSON，新增 buildControlMessages 副大腦 prompt"
```

---

## Task 5: turn.ts — runTurnCore 改為主腦串流 + 副大腦抽取兩段流程

**Files:**
- Modify: `src/engine/turn.ts`（`TurnDeps` 加 `controlClient`；`runTurnCore` 改寫；`TurnPlan` 調整；`runMainSpaceTurn`/`runDungeonTurn` 傳 control 建構器；移除 `createNarrativeSplitter`/`parseTurnOutput` 使用）
- Test: `src/engine/turn.test.ts`（改寫所有走完整回合的測試的 mock 為「主腦純散文 + 副大腦 JSON」）

**Interfaces:**
- Consumes: `buildControlMessages`（Task 4）、`parseControlOutput`（Task 2）、`listDungeonIds`（Task 3）、既有 `appendJournal`/`appendRun`/`appendWikiReveals`/`applyNowChanges`/`serializeNow`/`bumpNowUpdated`。
- Produces:
  - `TurnDeps.controlClient?: LlmClient`（未設定退回 `deps.client`）。
  - `runTurnCore` 行為：先串流主腦純散文（delta 直接轉發），取得完整 `narrative` 後呼叫副大腦取 `TurnControl`；副大腦失敗時降級（敘事已落地、`now.md` 只 bump、`awaiting_user_input=true`、發 warning）。下游落地邏輯（raw/now/積分/wiki/commit/done event）不變。

- [ ] **Step 1: 加 controlClient 到 TurnDeps**

在 `src/engine/turn.ts` 的 `TurnDeps` interface（第 25-35 行），`characterClient?` 之後加入：

```typescript
  /** 結構控制抽取 LLM（副大腦）；未提供時退回 deps.client */
  controlClient?: LlmClient;
```

- [ ] **Step 2: 改寫完整回合測試的 mock 輔助**

在 `src/engine/turn.test.ts`：

(a) 把 `control(awaiting, summary)` 輔助（第 30-42 行）改成只回 JSON（副大腦用）：

```typescript
function controlJson(awaiting: boolean, summary: string): string {
  return JSON.stringify({
    state_changes: {},
    rolls: [],
    mode_transition: null,
    awaiting_user_input: awaiting,
    suggested_actions: [],
    commit_summary: summary,
  });
}
```

(b) 新增一個「兩段式」client 輔助：每回合主腦先回散文、副大腦再回 JSON，用同一個 sequenced client 交替：

```typescript
/** 兩段式：依序回應，主腦散文與副大腦 JSON 交替由同一序列供應 */
function twoBrainClient(responses: string[]): LlmClient {
  let i = 0;
  return {
    async *streamChat(_m: ChatMessage[]): AsyncIterable<string> {
      yield responses[Math.min(i, responses.length - 1)];
      i++;
    },
  };
}
```

（`sequencedClient` 與 `fakeClient` 保留，仍被部分測試使用。）

- [ ] **Step 3: 改寫 runMainSpaceTurn 結構化輸出測試**

把 `describe("runMainSpaceTurn — 結構化輸出"...)` 第一個測試（`it("串流敘事、套用 now/積分..."`）改為：主腦回純散文、副大腦（注入 `controlClient`）回 JSON：

```typescript
  it("串流敘事、副大腦套用 now/積分、commit，done 帶 awaitingUserInput/suggestedActions", async () => {
    const commits: string[] = [];
    const narrative = "沈奕走進資訊室。";
    const ctrl = JSON.stringify({
      state_changes: { now: { scene: "資訊室", nextStep: "找葉晴" }, protagonist_points_delta: 2 },
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: ["找葉晴", "離開"],
      commit_summary: "沈奕進資訊室",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient([narrative]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async (m) => { commits.push(m); return true; },
        today: () => "2026-06-19",
        dicePool: [10, 20],
      },
      "去資訊室",
    )) {
      events.push(ev);
    }

    const streamed = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
    expect(streamed).toContain("沈奕走進資訊室。");
    expect(streamed).not.toContain("===STATE===");

    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.awaitingUserInput).toBe(true);
    expect(done.suggestedActions).toEqual(["找葉晴", "離開"]);

    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("- 此刻場景/地點：資訊室");
    expect(now).toContain("- 主角下一步打算：找葉晴");
    expect(now).toContain("- 最後更新：[2026-06-19] 沈奕進資訊室");

    const prot = await readFile(path.join(world, "characters", "protagonist.md"), "utf8");
    expect(prot).toContain("- 當前積分：2");

    const journal = await readFile(path.join(world, "journal.md"), "utf8");
    expect(journal).toContain("## [2026-06-19] 沈奕進資訊室");
    expect(journal).toContain("去資訊室");

    expect(commits).toEqual(["沈奕進資訊室"]);
  });
```

把第二個測試（`it("缺 sentinel 時降級..."`）改為「副大腦回壞 JSON 時降級」：

```typescript
  it("副大腦輸出無法解析時降級：保留敘事、發 warning、暫停、仍 commit", async () => {
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["這是一段正常敘事。"]),
        controlClient: fakeClient(["副大腦壞掉了，沒有 JSON"]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "做點事",
    )) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === "warning")).toBe(true);
    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.awaitingUserInput).toBe(true); // 降級保守暫停
    const streamed = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
    expect(streamed).toContain("這是一段正常敘事。");
    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("- 最後更新：[2026-06-19]");
  });

  it("副大腦呼叫整個拋錯時也降級（不中斷回合）", async () => {
    const throwingControl: LlmClient = {
      async *streamChat() { throw new Error("control LLM 掛了"); yield ""; },
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["敘事正常。"]),
        controlClient: throwingControl,
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "做點事",
    )) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === "warning")).toBe(true);
    const done: any = events.at(-1);
    expect(done.awaitingUserInput).toBe(true);
  });
```

- [ ] **Step 4: 改寫 runTurnLoop 自動推進測試**

`describe("runTurnLoop — 自動推進"...)` 的兩個測試用單一 `client`（會同時當主腦與副大腦，因為 `controlClient` 預設退回 `client`）。每回合會呼叫 client 兩次：主腦散文、副大腦 JSON。改用 `twoBrainClient`，序列為「散文, JSON, 散文, JSON…」：

第一個測試：

```typescript
  it("awaiting_user_input=false 時自動接續，遇 true 停止", async () => {
    const events: TurnEvent[] = [];
    for await (const ev of runTurnLoop(
      {
        client: twoBrainClient([
          "系統倒數推進敘事",          // turn 0 主腦
          controlJson(false, "系統倒數推進"), // turn 0 副大腦
          "需要玩家決定的敘事",        // turn 1 主腦
          controlJson(true, "需要玩家決定"),  // turn 1 副大腦
        ]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
      },
      "等待",
      3,
    )) {
      events.push(ev);
    }
    const dones = events.filter((e) => e.type === "done") as any[];
    expect(dones).toHaveLength(2);
    expect(dones[0].awaitingUserInput).toBe(false);
    expect(dones[1].awaitingUserInput).toBe(true);
    expect(events.some((e) => e.type === "auto-advance")).toBe(true);
  });
```

第二個測試（達上限）——序列一直回散文/JSON，`twoBrainClient` 末端會重複最後一個元素，但這樣主腦會拿到 JSON 字串當散文。為避免錯亂，提供足量交替元素（1 初始 + 2 自動 = 3 回合 = 6 次呼叫）：

```typescript
  it("達 maxAuto 上限即停（即使一直 false）", async () => {
    const responses: string[] = [];
    for (let k = 0; k < 3; k++) {
      responses.push(`持續推進敘事 ${k}`);
      responses.push(controlJson(false, "持續推進"));
    }
    const events: TurnEvent[] = [];
    for await (const ev of runTurnLoop(
      {
        client: twoBrainClient(responses),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
      },
      "等待",
      2,
    )) {
      events.push(ev);
    }
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(3);
  });
```

- [ ] **Step 5: 改寫 runDungeonTurn 測試**

`describe("runDungeonTurn"...)` 測試改為主腦散文 + 副大腦 JSON：

```typescript
    const narrative = "你踏入大廳，三道門並排。";
    const ctrl = JSON.stringify({
      state_changes: { wiki_reveals: ["入口大廳有三道門"] },
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: [],
      commit_summary: "進入大廳",
    });

    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(
      {
        client: fakeClient([narrative]),
        controlClient: fakeClient([ctrl]),
        worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [5],
      },
      "往前走",
    )) {
      events.push(ev);
    }
```

（後續 assertions 不變。）

- [ ] **Step 6: 改寫 pre-pass 整合測試**

`describe("pre-pass 整合測試"...)` 兩個測試中，`mainClient` 目前回「敘事+sentinel+JSON」。改為 `mainClient` 只回散文，並注入 `controlClient` 回 JSON。第一個測試：

```typescript
    const controlClient: LlmClient = {
      async *streamChat() {
        yield JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        });
      },
    };
    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        capturedSystem = msgs[0].content;
        yield "純敘事內容";
      },
    };
```

deps 加 `controlClient`。assertion `expect(capturedSystem).toContain("## 在場角色本回合意圖")` 不變（pre-pass 注入主腦 system）。

第二個測試（characterClient 失敗降級）同樣把 `mainClient` 改回純散文、加 `controlClient` 回合法 JSON：

```typescript
    const mainClient: LlmClient = {
      async *streamChat() { yield "敘事"; },
    };
    const controlClient: LlmClient = {
      async *streamChat() {
        yield JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        });
      },
    };
```

deps 加 `controlClient`。

- [ ] **Step 7: 改寫 enter/settle 副本測試**

`describe("runTurnLoop — 進入/結算副本..."` 的呼叫序列改為（每回合主腦+副大腦兩次，加 secrets 生成一次）：

```typescript
    const enterCtl = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: "enter_dungeon",
      transition_dungeon_id: "U-TEST", awaiting_user_input: false, suggested_actions: [], commit_summary: "系統強制開啟副本",
    });
    const settleCtl = JSON.stringify({
      state_changes: { wiki_reveals: ["出口在東側"] }, rolls: [], mode_transition: "settle_dungeon",
      awaiting_user_input: true, suggested_actions: [], commit_summary: "撤離副本",
    });
    const client = twoBrainClient([
      "系統警報響起。",     // turn 0 主腦（主空間）
      enterCtl,            // turn 0 副大腦 → enter_dungeon
      "這個副本真正的機關是潮汐淹沒。", // secrets 生成（generateSecrets 用 deps.client）
      "你抵達出口。",       // turn 1 主腦（副本）
      settleCtl,           // turn 1 副大腦 → settle_dungeon
    ]);
```

> 重要：`generateSecrets` 用的是 `deps.client`（主 client）。由於本測試 `controlClient` 未注入而退回 `deps.client`，主腦敘事、secrets、副大腦 JSON 全走同一個 `twoBrainClient` 序列，順序即上方註解所示。後續 assertions（transitions、secrets、runs、wiki、now）不變。

- [ ] **Step 8: 跑測試確認失敗**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/turn.test.ts`
Expected: FAIL（`runTurnCore` 尚未改寫，仍走 splitter + parseTurnOutput）

- [ ] **Step 9: 改寫 runTurnCore 與兩個 runXxxTurn**

在 `src/engine/turn.ts`：

(a) 更新 import（第 9-10 行）：移除 `createNarrativeSplitter`，把 `parseTurnOutput` 換 `parseControlOutput`，並 import `listDungeonIds`：

```typescript
import { parseControlOutput, type TurnControl } from "./schema.js";
```

`dungeon.js` 既有 import（第 11-18 行）加入 `listDungeonIds`。刪除 `import { createNarrativeSplitter } from "./stream-split.js";`。

(b) `TurnPlan` interface（第 183-189 行）改成讓 plan 提供「依敘事建構副大腦訊息」的閉包：

```typescript
interface TurnPlan {
  /** 主腦（敘事）訊息 */
  messages: ChatMessage[];
  /** 副大腦（結構抽取）訊息建構器：拿主腦完整敘事，回傳 control 對話 */
  buildControl: (narrative: string) => ChatMessage[];
  /** raw 層落地：主空間→journal，副本→runs/<run>.md */
  appendRaw: (entry: { date: string; title: string; body: string }) => Promise<void>;
  /** 額外提煉：副本把 wiki_reveals 寫進 wiki.md */
  distill?: (control: TurnControl, date: string) => Promise<void>;
}
```

(c) 改寫 `runTurnCore`（第 191-289 行）主腦串流 + 副大腦抽取段落。把開頭到 `narrative = full.trim();`（第 200-224 行）換成：

```typescript
  log.debug({ dicePool }, "回合開始");

  // 1) 主腦：串流純敘事，delta 直接轉發（不再做 sentinel 切分）
  let narrative = "";
  for await (const delta of deps.client.streamChat(plan.messages)) {
    narrative += delta;
    yield { type: "delta", text: delta };
  }
  narrative = narrative.trim();

  // 2) 副大腦：讀完整敘事抽結構；失敗則降級（敘事已落地、暫停等玩家）
  const controlClient = deps.controlClient ?? deps.client;
  let control: TurnControl | null = null;
  try {
    let raw = "";
    for await (const delta of controlClient.streamChat(plan.buildControl(narrative))) {
      raw += delta;
    }
    control = parseControlOutput(raw);
  } catch (err) {
    log.error({ err }, "副大腦結構抽取失敗，本回合僅保留敘事並暫停");
    yield {
      type: "warning",
      message: `副大腦結構抽取失敗，本回合僅保留敘事並暫停：${(err as Error).message}`,
    };
  }
```

第 226 行之後（`if (control && control.rolls.length > 0)` 起）到函式結尾的落地/commit/done 邏輯**完全不變**（`summary`、raw 層、now.md、積分、distill、commit、done event 都照舊；`control` 為 null 時的分支已存在）。

(d) `runMainSpaceTurn`（第 335-356 行）：在組 plan 前先讀現有副本 id，並提供 `buildControl` 閉包。把 `yield* runTurnCore(...)` 的 plan 物件改成：

```typescript
  const existingDungeonIds = await listDungeonIds(deps.worldDir, log);

  yield* runTurnCore(
    deps,
    input,
    state,
    dicePool,
    today,
    {
      messages: buildMainSpaceMessages({ settingText, state, input, dicePool, intentsBlock }),
      buildControl: (narrative) =>
        buildControlMessages({ settingText, state, input, narrative, dicePool, existingDungeonIds }),
      appendRaw: (entry) => appendJournal(deps.worldDir, entry),
    },
    log,
  );
```

(e) `runDungeonTurn`（第 376-393 行）：plan 物件改成：

```typescript
  const existingDungeonIds = await listDungeonIds(deps.worldDir, log);

  yield* runTurnCore(
    deps,
    input,
    state,
    dicePool,
    today,
    {
      messages: buildDungeonMessages({
        settingText, state, input, dicePool,
        dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
        intentsBlock,
      }),
      buildControl: (narrative) =>
        buildControlMessages({
          settingText, state, input, narrative, dicePool, existingDungeonIds,
          dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
        }),
      appendRaw: (entry) => appendRun(deps.worldDir, active.dungeonId, active.runId, entry),
      distill: (control, date) =>
        appendWikiReveals(deps.worldDir, active.dungeonId, control.state_changes.wiki_reveals ?? [], date, log),
    },
    log,
  );
```

- [ ] **Step 10: 跑 engine 全部測試確認通過**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/`
Expected: PASS（schema/dungeon/turn 全綠）

- [ ] **Step 11: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app
git add src/engine/turn.ts src/engine/turn.test.ts
git commit -m "feat(turn): runTurnCore 改為主腦串流 + 副大腦抽取兩段流程"
```

---

## Task 6: 接線 server controlClient + 移除 stream-split + 全綠驗證

**Files:**
- Modify: `src/server/app.ts`（建立 `controlClient` 並傳入 `runTurnLoop`）
- Delete: `src/engine/stream-split.ts`、`src/engine/stream-split.test.ts`
- Test: `src/server/app.test.ts`（既有 SSE 測試需確認仍綠——見下）

**Interfaces:**
- Consumes: `AppConfig.control`（Task 1）、`TurnDeps.controlClient`（Task 5）、既有 `createOpenAiClient`。
- Produces: server 在 `config.control` 有值時建立獨立 control client，否則傳 `undefined`（engine 退回主 client）。

- [ ] **Step 1: server 接線 controlClient**

在 `src/server/app.ts`：`ServerDeps` interface（第 20-25 行）加入：

```typescript
  controlClient?: LlmClient;
```

在 `characterClient` 建立區塊（第 43-57 行）之後，新增同模式的 `controlClient`：

```typescript
  const controlClient: LlmClient | undefined =
    deps.controlClient ??
    (config.control
      ? createOpenAiClient(
          {
            ...config,
            openai: {
              baseUrl: config.control.baseUrl,
              apiKey: config.openai.apiKey,
              model: config.control.model,
            },
          },
          logger,
        )
      : undefined);
```

在 `runTurnLoop` 的 deps（第 102-109 行）加入 `controlClient`：

```typescript
        {
          client: makeClient(turnLogger),
          characterClient,
          controlClient,
          worldDir: config.worldDir,
          commit: makeCommit(turnLogger),
          logger: turnLogger,
        },
```

- [ ] **Step 2: 更新 server SSE 測試的 fake client**

`src/server/app.test.ts` 的 SSE 測試（第 75-93 行）只注入 `client: fakeClient(["前半段，", "後半段。"])`。改寫後該 client 會同時被當主腦（散文）與副大腦（JSON）使用——副大腦會拿到「前半段，後半段。」當 JSON 解析而失敗，觸發降級（仍會有 delta 與 done，commit 仍發生）。測試斷言 `"type":"delta"`、`前半段`、`"type":"done"`、`commits` 長度 1 仍成立，但為精確起見，明確注入 `controlClient` 回合法 JSON：

```typescript
  it("以 SSE 串流 delta 與 done 事件", async () => {
    const commits: string[] = [];
    const server = buildServer(loadConfig({ WORLD_DIR: world }), {
      client: fakeClient(["前半段，", "後半段。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "看看四周",
        }),
      ]),
      commit: async (m) => { commits.push(m); return true; },
    });
    const res = await server.inject({
      method: "POST",
      url: "/api/turn",
      payload: { input: "我四處看看" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain('"type":"delta"');
    expect(res.body).toContain("前半段");
    expect(res.body).toContain('"type":"done"');
    expect(commits).toHaveLength(1);
    await server.close();
  });
```

- [ ] **Step 3: 刪除 stream-split**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app
git rm src/engine/stream-split.ts src/engine/stream-split.test.ts
```

- [ ] **Step 4: 確認無殘留引用**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && grep -rn "stream-split\|createNarrativeSplitter\|STATE_SENTINEL\|parseTurnOutput" src/`
Expected: 無任何輸出（全部已移除）

- [ ] **Step 5: typecheck + 全測試 + build**

Run: `cd /Users/kk/projects/Inifinity-world-adventure/app && npm run typecheck && npm test && npm run build`
Expected: typecheck 無錯、所有測試 PASS、build 成功

若 typecheck 報 `parseTurnOutput`/`ParsedTurn`/`createNarrativeSplitter` 仍被引用，回到對應 Task 修正殘留 import。

- [ ] **Step 6: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app
git add src/server/app.ts src/server/app.test.ts
git commit -m "feat(server): 接線副大腦 controlClient 並移除 stream-split"
```

---

## Self-Review

**Spec coverage：**

- 主腦只輸出純散文、不需 sentinel → Task 4（prompt 去 JSON）、Task 5 Step 9(c)（移除 splitter，delta 直接轉發）。✓
- 副大腦獨立可設定 client（`controlClient`，退回 `client`）→ Task 1（config）、Task 5 Step 1（TurnDeps）、Task 6（server 接線）。✓
- 副大腦輸入：完整散文 + 玩家輸入 + 設定 + canonical + 骰池 + (副本) wiki/secrets + 現有副本 id 列表 → Task 4（`buildControlMessages`）、Task 3（`listDungeonIds`）。✓
- 副大腦輸出整段 JSON、走既有 `TurnControlSchema`、不改 schema 欄位 → Task 2（`parseControlOutput`，schema 不動）。✓
- `mode_transition`/slug 為副大腦欄位，餵現有 id 判斷續用/新建 → Task 4 system prompt + `existingDungeonIds`。✓
- 降級：敘事已落地、now 只 bump、不套狀態、`awaiting_user_input=true`、發 warning → Task 5 Step 3/9（catch 區塊，沿用既有 control=null 下游分支）。✓
- 骰值機制不變 → 全程未動 `roll.ts`；副大腦只抽取。✓
- raw/now/積分/wiki/commit 落地不變 → Task 5 Step 9(c) 明確保留第 226 行後邏輯。✓
- 測試策略（mock 拆兩段、副大腦失敗降級新測試、schema/stream-split 調整）→ Task 2/5/6。✓
- 範圍外（不改骰值、不改 schema 欄位、不加第三 agent、不動 pre-pass）→ 計畫未觸及這些。✓

**Placeholder scan：** 無 TBD/TODO；每個改 code 的步驟都有完整程式碼與確切路徑/行號。✓

**Type consistency：** `parseControlOutput`（Task 2 產出）↔ Task 5 import 一致；`buildControlMessages`/`BuildControlParams`（Task 4）↔ Task 5 呼叫的具名參數一致；`TurnDeps.controlClient`（Task 5）↔ `ServerDeps.controlClient`/接線（Task 6）一致；`listDungeonIds`（Task 3）↔ Task 5 呼叫簽章 `(worldDir, log)` 一致；`AppConfig.control`（Task 1）↔ Task 6 讀取 `config.control.baseUrl/model` 一致。✓

**Task 排序風險：** Task 2/4/5 之間，單檔測試會綠但全專案 typecheck 暫時壞（已在 Task 2 Step 4、Task 4 Step 7 標註預期）；Task 6 Step 5 做最終全綠把關。此為 TDD 漸進過程的正常狀態，非缺陷。
