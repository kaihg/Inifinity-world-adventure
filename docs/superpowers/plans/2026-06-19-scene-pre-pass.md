# Scene Pre-pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在每回合敘事 call 之前，對當前場景的每個 NPC 各跑一次輕量 LLM call 取得意圖（stance/intent/tone），注入敘事 system prompt，解決 NPC 缺乏自主性的問題。

**Architecture:** 在 `runMainSpaceTurn` / `runDungeonTurn` 組 messages 前先呼叫新的 `character-pre-pass.ts` 模組，並行對每個有角色檔的在場 NPC 發出獨立意圖 call，將結果格式化後插入 system prompt 的 `canonicalBlock` 之後。失敗的 NPC 靜默略過，不 block 回合。

**Tech Stack:** TypeScript, Vitest, Zod, Node.js `fs/promises`

## Global Constraints

- 所有新檔案使用 `.ts` 副檔名，匯入用 `.js` 副檔名（現有慣例）
- Zod 用於 LLM 輸出 schema 驗證
- 測試框架：Vitest（`cd app && npm test`）
- TDD：先寫失敗測試，再寫實作
- 每個 task 結尾必須 commit
- `characterClient` 缺省時 fallback 到主 `client`（零 migration cost）
- 新增的 `.env` 變數全部 optional

---

## File Map

| 檔案 | 動作 | 職責 |
|------|------|------|
| `app/src/engine/character-pre-pass.ts` | 建立 | 讀角色檔、並行發意圖 call、回傳 `CharacterIntent[]` |
| `app/src/engine/character-pre-pass.test.ts` | 建立 | 上述模組的單元測試 |
| `app/src/config.ts` | 修改 | 新增 `character` 選填設定區塊 |
| `app/src/config.test.ts` | 修改 | 驗證新設定欄位的解析行為 |
| `app/src/engine/turn.ts` | 修改 | `TurnDeps` 新增 `characterClient?`；`buildMainSpaceMessages` / `buildDungeonMessages` 接受 `intents` 參數；`runMainSpaceTurn` / `runDungeonTurn` 在組 messages 前呼叫 pre-pass |
| `app/src/engine/turn.test.ts` | 修改 | 驗證 intents 注入行為、pre-pass 失敗時降級行為 |
| `app/src/server/app.ts` | 修改 | 從 config 建立 `characterClient` 並注入 `TurnDeps` |
| `app/src/server/app.test.ts` | 修改 | `ServerDeps` 支援 `characterClient` 注入 |
| `app/.env.example` | 修改 | 新增 `CHARACTER_OPENAI_BASE_URL` / `CHARACTER_MODEL` 說明 |

---

## Task 1：`config.ts` 新增 character 設定

**Files:**
- Modify: `app/src/config.ts`
- Modify: `app/src/config.test.ts`

**Interfaces:**
- Produces: `AppConfig.character?: { baseUrl: string; model: string }`

- [ ] **Step 1: 寫失敗測試**

在 `app/src/config.test.ts` 找到現有 `describe('loadConfig'` 區塊，加入：

```typescript
it("character 欄位：有設定時解析", () => {
  const config = loadConfig({
    OPENAI_BASE_URL: "http://main/v1",
    OPENAI_API_KEY: "key",
    MODEL: "main-model",
    CHARACTER_OPENAI_BASE_URL: "http://char/v1",
    CHARACTER_MODEL: "qwen2.5:3b",
  });
  expect(config.character).toEqual({
    baseUrl: "http://char/v1",
    model: "qwen2.5:3b",
  });
});

it("character 欄位：未設定時為 undefined", () => {
  const config = loadConfig({
    OPENAI_BASE_URL: "http://main/v1",
    OPENAI_API_KEY: "key",
    MODEL: "main-model",
  });
  expect(config.character).toBeUndefined();
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose config
```

預期：`TypeError: ... character` 或 `AssertionError`

- [ ] **Step 3: 修改 `config.ts`**

在 `AppConfig` interface 加欄位：

```typescript
/** 角色意圖 LLM（選填）；缺省時 engine 沿用主 client */
character?: {
  baseUrl: string;
  model: string;
};
```

在 `loadConfig` 的 return 物件加：

```typescript
character:
  env.CHARACTER_OPENAI_BASE_URL && env.CHARACTER_MODEL
    ? {
        baseUrl: env.CHARACTER_OPENAI_BASE_URL,
        model: env.CHARACTER_MODEL,
      }
    : undefined,
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd app && npm test -- --reporter=verbose config
```

預期：全 PASS

- [ ] **Step 5: 更新 `.env.example`**

在 `app/.env.example` 末尾加入：

```env

# 角色意圖 LLM（選填；缺省沿用主 LLM）
# CHARACTER_OPENAI_BASE_URL=http://localhost:11434/v1
# CHARACTER_MODEL=qwen2.5:3b
```

- [ ] **Step 6: Commit**

```bash
git add app/src/config.ts app/src/config.test.ts app/.env.example
git commit -m "feat(config): 新增 character LLM 選填設定"
```

---

## Task 2：`character-pre-pass.ts` 核心模組

**Files:**
- Create: `app/src/engine/character-pre-pass.ts`
- Create: `app/src/engine/character-pre-pass.test.ts`

**Interfaces:**
- Consumes: `LlmClient` from `../llm/client.js`
- Produces:
  ```typescript
  interface CharacterIntent {
    id: string;
    stance: string;
    intent: string;
    tone: string;
  }
  async function runCharacterPrePass(
    params: CharacterPrePassParams
  ): Promise<CharacterIntent[]>
  ```

- [ ] **Step 1: 寫失敗測試**

建立 `app/src/engine/character-pre-pass.test.ts`：

```typescript
import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { runCharacterPrePass } from "./character-pre-pass.js";
import type { LlmClient } from "../llm/client.js";

function makeClient(response: string): LlmClient {
  return {
    async *streamChat() {
      yield response;
    },
  };
}

async function makeWorld(npcs: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "world-"));
  const charsDir = path.join(dir, "characters");
  await mkdir(charsDir, { recursive: true });
  for (const [id, content] of Object.entries(npcs)) {
    await writeFile(path.join(charsDir, `${id}.md`), content, "utf8");
  }
  return dir;
}

describe("runCharacterPrePass", () => {
  it("有角色檔的 NPC 回傳意圖", async () => {
    const worldDir = await makeWorld({
      yeqing: "# 葉晴\n前特種部隊教官",
    });
    const client = makeClient(
      JSON.stringify({ stance: "觀察", intent: "提出暗號方案", tone: "冷靜" })
    );
    const result = await runCharacterPrePass({
      npcIds: ["yeqing"],
      scene: "安全區大廳",
      playerInput: "測試行動",
      worldDir,
      client,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "yeqing",
      stance: "觀察",
      intent: "提出暗號方案",
      tone: "冷靜",
    });
  });

  it("缺角色檔的 NPC 靜默略過", async () => {
    const worldDir = await makeWorld({});
    const client = makeClient("{}");
    const result = await runCharacterPrePass({
      npcIds: ["ghost"],
      scene: "廢墟",
      playerInput: "行動",
      worldDir,
      client,
    });
    expect(result).toHaveLength(0);
  });

  it("LLM 輸出 JSON 格式錯誤時靜默略過", async () => {
    const worldDir = await makeWorld({ bad: "# Bad NPC" });
    const client = makeClient("不是JSON");
    const result = await runCharacterPrePass({
      npcIds: ["bad"],
      scene: "場景",
      playerInput: "行動",
      worldDir,
      client,
    });
    expect(result).toHaveLength(0);
  });

  it("多個 NPC 並行處理全部回傳", async () => {
    const worldDir = await makeWorld({
      npc1: "# NPC1",
      npc2: "# NPC2",
    });
    const intentJson = JSON.stringify({ stance: "立場", intent: "意圖", tone: "語氣" });
    const client = makeClient(intentJson);
    const result = await runCharacterPrePass({
      npcIds: ["npc1", "npc2"],
      scene: "場景",
      playerInput: "行動",
      worldDir,
      client,
    });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["npc1", "npc2"]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose character-pre-pass
```

預期：`Cannot find module './character-pre-pass.js'`

- [ ] **Step 3: 實作 `character-pre-pass.ts`**

建立 `app/src/engine/character-pre-pass.ts`：

```typescript
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmClient, ChatMessage } from "../llm/client.js";

export interface CharacterIntent {
  id: string;
  stance: string;
  intent: string;
  tone: string;
}

export interface CharacterPrePassParams {
  npcIds: string[];
  scene: string;
  playerInput: string;
  worldDir: string;
  client: LlmClient;
}

const IntentSchema = z.object({
  stance: z.string().min(1),
  intent: z.string().min(1),
  tone: z.string().min(1),
});

async function fetchIntent(
  id: string,
  characterMd: string,
  scene: string,
  playerInput: string,
  client: LlmClient,
): Promise<CharacterIntent | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是角色意圖分析器。根據角色檔案與當前場景，輸出該角色在本回合的立場、意圖、語氣。",
        "只輸出單一 JSON 物件，不要前言或後語。格式：",
        '{ "stance": "一句話描述立場", "intent": "一句話描述意圖", "tone": "語氣標籤" }',
        "",
        "## 角色檔案",
        characterMd.trim(),
      ].join("\n"),
    },
    {
      role: "user",
      content: `當前場景：${scene}\n玩家行動：${playerInput}`,
    },
  ];

  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = IntentSchema.parse(JSON.parse(raw.slice(start, end + 1)));
    return { id, ...parsed };
  } catch {
    return null;
  }
}

/** 對在場 NPC 並行發意圖 call；缺角色檔或解析失敗的 NPC 靜默略過 */
export async function runCharacterPrePass(
  params: CharacterPrePassParams,
): Promise<CharacterIntent[]> {
  const { npcIds, scene, playerInput, worldDir, client } = params;

  const results = await Promise.all(
    npcIds.map(async (id): Promise<CharacterIntent | null> => {
      const filePath = path.join(worldDir, "characters", `${id}.md`);
      let characterMd: string;
      try {
        characterMd = await readFile(filePath, "utf8");
      } catch {
        return null;
      }
      return fetchIntent(id, characterMd, scene, playerInput, client);
    }),
  );

  return results.filter((r): r is CharacterIntent => r !== null);
}

/** 把 CharacterIntent[] 格式化為注入 system prompt 的區塊 */
export function formatIntentsBlock(intents: CharacterIntent[], npcNames: Record<string, string>): string {
  if (intents.length === 0) return "";
  const lines = [
    "## 在場角色本回合意圖（pre-pass 生成，必須遵守）",
  ];
  for (const { id, stance, intent, tone } of intents) {
    const display = npcNames[id] ? `${npcNames[id]}（${id}）` : id;
    lines.push(`### ${display}`, `- 立場：${stance}`, `- 意圖：${intent}`, `- 語氣：${tone}`, "");
  }
  return lines.join("\n").trimEnd();
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd app && npm test -- --reporter=verbose character-pre-pass
```

預期：全 PASS

- [ ] **Step 5: 補 `formatIntentsBlock` 測試**

在 `character-pre-pass.test.ts` 補：

```typescript
import { formatIntentsBlock } from "./character-pre-pass.js";

describe("formatIntentsBlock", () => {
  it("空陣列回傳空字串", () => {
    expect(formatIntentsBlock([], {})).toBe("");
  });

  it("有意圖時回傳格式化區塊", () => {
    const block = formatIntentsBlock(
      [{ id: "yeqing", stance: "觀察", intent: "提暗號方案", tone: "冷靜" }],
      { yeqing: "葉晴" }
    );
    expect(block).toContain("## 在場角色本回合意圖");
    expect(block).toContain("### 葉晴（yeqing）");
    expect(block).toContain("- 立場：觀察");
    expect(block).toContain("- 意圖：提暗號方案");
    expect(block).toContain("- 語氣：冷靜");
  });

  it("缺 npcNames 時用 id 顯示", () => {
    const block = formatIntentsBlock(
      [{ id: "unknown", stance: "s", intent: "i", tone: "t" }],
      {}
    );
    expect(block).toContain("### unknown");
  });
});
```

```bash
cd app && npm test -- --reporter=verbose character-pre-pass
```

預期：全 PASS

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/character-pre-pass.ts app/src/engine/character-pre-pass.test.ts
git commit -m "feat(engine): 新增 character-pre-pass 模組"
```

---

## Task 3：`turn.ts` 整合 pre-pass

**Files:**
- Modify: `app/src/engine/turn.ts`
- Modify: `app/src/engine/turn.test.ts`

**Interfaces:**
- Consumes:
  - `runCharacterPrePass`, `formatIntentsBlock`, `CharacterIntent` from `./character-pre-pass.js`
  - `TurnDeps.characterClient?: LlmClient`
- Produces:
  - `buildMainSpaceMessages(params: BuildMessagesParams & { intentsBlock?: string })`
  - `buildDungeonMessages(params: BuildDungeonMessagesParams & { intentsBlock?: string })`

- [ ] **Step 1: 寫失敗測試**

在 `app/src/engine/turn.test.ts` 找到現有 `buildMainSpaceMessages` 的測試區塊，加入：

```typescript
it("intentsBlock 有值時出現在 system prompt", () => {
  const params = {
    settingText: "設定",
    state: makeFakeState(),
    input: "行動",
    dicePool: [50],
    intentsBlock: "## 在場角色本回合意圖\n### 葉晴（yeqing）\n- 立場：觀察",
  };
  const msgs = buildMainSpaceMessages(params);
  expect(msgs[0].content).toContain("## 在場角色本回合意圖");
});

it("intentsBlock 為空字串時 system prompt 不含意圖區塊標題", () => {
  const params = {
    settingText: "設定",
    state: makeFakeState(),
    input: "行動",
    dicePool: [50],
    intentsBlock: "",
  };
  const msgs = buildMainSpaceMessages(params);
  expect(msgs[0].content).not.toContain("## 在場角色本回合意圖");
});
```

> `makeFakeState()` 是 `turn.test.ts` 現有輔助函式，若無則自行定義：
> ```typescript
> function makeFakeState(): GameState {
>   return {
>     now: { chapter: "c", scene: "s", companions: "", activeDungeon: "無", threads: "", nextStep: "", lastUpdated: "" },
>     protagonist: { name: "沈奕", points: "100" },
>     protagonistDetail: { name: "沈奕", points: "100", attributes: "", skills: "", items: "", buffs: "" },
>     npcs: [],
>     mode: "main-space",
>   };
> }
> ```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd app && npm test -- --reporter=verbose turn
```

預期：`AssertionError` 或 `TypeError`

- [ ] **Step 3: 修改 `turn.ts` — buildMainSpaceMessages / buildDungeonMessages**

在 `BuildMessagesParams` interface 加欄位：

```typescript
export interface BuildMessagesParams {
  settingText: string;
  state: GameState;
  input: string;
  dicePool: number[];
  intentsBlock?: string; // ← 新增
}
```

在 `buildMainSpaceMessages` 的 system 陣列，在 `canonicalBlock(state)` 之後插入：

```typescript
...(params.intentsBlock ? ["", params.intentsBlock] : []),
```

完整的 system 組裝段落（修改後）：

```typescript
const system = [
  "你是「無限恐怖」世界的敘事引擎，扮演冷酷機械的主控系統與世界本身，",
  "推進主角在「主神空間安全區」（副本之間的安全區）的劇情。",
  "",
  "## 鐵則",
  "- 全程使用繁體中文與台灣用詞。",
  "- 嚴格遵守下方世界設定，不可竄改既定規則或角色屬性/積分數值。",
  "- 不可揭露任何尚未在劇情中揭露的隱藏設定。",
  "- 只敘述主空間互動；若劇情走到系統強制開啟副本，把 mode_transition 設為 enter_dungeon 並填 transition_dungeon_id，不要自行切到副本內部。",
  "- 需要機率判定時，**只能依序取用下方『本回合骰值』**，不可自行編造數字；用到的骰值要在 rolls 回報。",
  "",
  OUTPUT_FORMAT_BLOCK,
  "",
  `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
  "",
  "## 世界設定（玩家可見規則）",
  settingText.trim(),
  "",
  canonicalBlock(state),
  ...(params.intentsBlock ? ["", params.intentsBlock] : []),
].join("\n");
```

對 `buildDungeonMessages` 做同樣修改：在 `BuildDungeonMessagesParams` 繼承 `BuildMessagesParams`（已含 `intentsBlock?`），在 system 陣列 `canonicalBlock(state)` 之後插入同樣的 spread：

```typescript
...(params.intentsBlock ? ["", params.intentsBlock] : []),
```

- [ ] **Step 4: 修改 `turn.ts` — TurnDeps 與 runMainSpaceTurn / runDungeonTurn**

在 `TurnDeps` interface 加欄位：

```typescript
export interface TurnDeps {
  client: LlmClient;
  characterClient?: LlmClient; // ← 新增
  worldDir: string;
  commit: (message: string) => Promise<boolean>;
  today?: () => string;
  dicePool?: number[];
}
```

在 `turn.ts` 頂部 import 加入：

```typescript
import {
  runCharacterPrePass,
  formatIntentsBlock,
} from "./character-pre-pass.js";
```

修改 `runMainSpaceTurn`：

```typescript
export async function* runMainSpaceTurn(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent> {
  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir);
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));

  const charClient = deps.characterClient ?? deps.client;
  const npcIds = state.npcs.map((n) => n.id);
  const npcNames = Object.fromEntries(state.npcs.map((n) => [n.id, n.name]));
  let intentsBlock = "";
  if (npcIds.length > 0) {
    try {
      const intents = await runCharacterPrePass({
        npcIds,
        scene: state.now.scene,
        playerInput: input,
        worldDir: deps.worldDir,
        client: charClient,
      });
      intentsBlock = formatIntentsBlock(intents, npcNames);
    } catch {
      // pre-pass 失敗不 block 回合
    }
  }

  yield* runTurnCore(deps, input, state, dicePool, today, {
    messages: buildMainSpaceMessages({ settingText, state, input, dicePool, intentsBlock }),
    appendRaw: (entry) => appendJournal(deps.worldDir, entry),
  });
}
```

修改 `runDungeonTurn`（在組 `buildDungeonMessages` 前插入同樣的 pre-pass 邏輯，`npcIds` / `npcNames` / `intentsBlock` 宣告方式一致）：

```typescript
export async function* runDungeonTurn(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent> {
  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir);
  const active = parseActiveDungeon(state.now.activeDungeon);
  if (!active) {
    yield* runMainSpaceTurn(deps, input);
    return;
  }
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));
  const lore = await loadDungeonLore(deps.worldDir, active.dungeonId);

  const charClient = deps.characterClient ?? deps.client;
  const npcIds = state.npcs.map((n) => n.id);
  const npcNames = Object.fromEntries(state.npcs.map((n) => [n.id, n.name]));
  let intentsBlock = "";
  if (npcIds.length > 0) {
    try {
      const intents = await runCharacterPrePass({
        npcIds,
        scene: state.now.scene,
        playerInput: input,
        worldDir: deps.worldDir,
        client: charClient,
      });
      intentsBlock = formatIntentsBlock(intents, npcNames);
    } catch {
      // pre-pass 失敗不 block 回合
    }
  }

  yield* runTurnCore(deps, input, state, dicePool, today, {
    messages: buildDungeonMessages({
      settingText, state, input, dicePool,
      dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      intentsBlock,
    }),
    appendRaw: (entry) =>
      appendRun(deps.worldDir, active.dungeonId, active.runId, entry),
    distill: (control, date) =>
      appendWikiReveals(deps.worldDir, active.dungeonId, control.state_changes.wiki_reveals ?? [], date),
  });
}
```

- [ ] **Step 5: 補 pre-pass 整合測試**

在 `turn.test.ts` 加入：

```typescript
it("characterClient 注入後意圖出現在 system prompt（主空間）", async () => {
  // fake characterClient 永遠回傳固定意圖
  const charClient: LlmClient = {
    async *streamChat() {
      yield JSON.stringify({ stance: "觀察", intent: "提暗號", tone: "冷靜" });
    },
  };
  // fake 主 client 收集 system prompt
  let capturedSystem = "";
  const mainClient: LlmClient = {
    async *streamChat(msgs) {
      capturedSystem = msgs[0].content;
      yield `敘事\n===STATE===\n${JSON.stringify({
        state_changes: {},
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "test",
      })}`;
    },
  };

  // 建立含 yeqing 角色檔的 worldDir
  const worldDir = await makeTempWorld({ withYeqing: true });
  const deps: TurnDeps = {
    client: mainClient,
    characterClient: charClient,
    worldDir,
    commit: async () => false,
  };
  const events = [];
  for await (const ev of runMainSpaceTurn(deps, "測試")) events.push(ev);

  expect(capturedSystem).toContain("## 在場角色本回合意圖");
});

it("characterClient 失敗時回合仍正常完成（降級）", async () => {
  const charClient: LlmClient = {
    async *streamChat() {
      throw new Error("LLM 掛了");
      yield "";
    },
  };
  const mainClient: LlmClient = {
    async *streamChat() {
      yield `敘事\n===STATE===\n${JSON.stringify({
        state_changes: {},
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "test",
      })}`;
    },
  };
  const worldDir = await makeTempWorld({ withYeqing: true });
  const deps: TurnDeps = {
    client: mainClient,
    characterClient: charClient,
    worldDir,
    commit: async () => false,
  };
  const events = [];
  for await (const ev of runMainSpaceTurn(deps, "測試")) events.push(ev);
  const done = events.find((e) => e.type === "done");
  expect(done).toBeDefined();
});
```

> `makeTempWorld` 是測試用輔助函式，在 `turn.test.ts` 頂部定義（若已有類似輔助函式，直接複用並擴充）：
> ```typescript
> async function makeTempWorld(opts: { withYeqing?: boolean } = {}): Promise<string> {
>   const dir = await mkdtemp(path.join(os.tmpdir(), "world-turn-"));
>   const charsDir = path.join(dir, "characters");
>   await mkdir(charsDir, { recursive: true });
>   // now.md
>   await writeFile(path.join(dir, "now.md"), [
>     "- 當前篇章：第一章",
>     "- 此刻場景/地點：安全區大廳",
>     "- 在場同伴/相關 NPC：葉晴",
>     "- 進行中的副本：無",
>     "- 未解懸念/伏筆：無",
>     "- 主角下一步打算：等待",
>     "- 最後更新：2026-06-19",
>   ].join("\n"), "utf8");
>   // protagonist.md
>   await writeFile(path.join(charsDir, "protagonist.md"), [
>     "- 姓名：沈奕",
>     "- 當前積分：100",
>   ].join("\n"), "utf8");
>   // index.md
>   await writeFile(path.join(charsDir, "index.md"), [
>     "| ID | 姓名 | 定位 | 最近狀態 |",
>     "|----|------|------|----------|",
>     "| yeqing | 葉晴 | NPC | 在場 |",
>   ].join("\n"), "utf8");
>   if (opts.withYeqing) {
>     await writeFile(path.join(charsDir, "yeqing.md"), "# 葉晴\n前特種部隊教官", "utf8");
>   }
>   return dir;
> }
> ```
> 需在 `turn.test.ts` 頂部加入：
> ```typescript
> import os from "node:os";
> import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
> ```

- [ ] **Step 6: 跑全部 turn 測試**

```bash
cd app && npm test -- --reporter=verbose turn
```

預期：全 PASS

- [ ] **Step 7: Commit**

```bash
git add app/src/engine/turn.ts app/src/engine/turn.test.ts
git commit -m "feat(engine): turn 整合 character pre-pass"
```

---

## Task 4：server 注入 characterClient

**Files:**
- Modify: `app/src/server/app.ts`
- Modify: `app/src/server/app.test.ts`

**Interfaces:**
- Consumes: `AppConfig.character?`, `createOpenAiClient`, `TurnDeps.characterClient?`
- Produces: `ServerDeps.characterClient?: LlmClient`

- [ ] **Step 1: 修改 `ServerDeps` 並更新 `app.ts`**

在 `app/src/server/app.ts` 的 `ServerDeps` interface 加欄位：

```typescript
export interface ServerDeps {
  client?: LlmClient;
  characterClient?: LlmClient; // ← 新增
  commit?: (message: string) => Promise<boolean>;
}
```

在 `buildServer` 內 `makeClient` 之後加：

```typescript
const makeCharacterClient = (): LlmClient | undefined => {
  if (deps.characterClient) return deps.characterClient;
  if (config.character) {
    return createOpenAiClient({
      ...config,
      openai: {
        baseUrl: config.character.baseUrl,
        apiKey: config.openai.apiKey,
        model: config.character.model,
      },
    });
  }
  return undefined;
};
```

在 `/api/turn` 路由的 `runTurnLoop` 呼叫改為：

```typescript
for await (const ev of runTurnLoop(
  {
    client: makeClient(),
    characterClient: makeCharacterClient(),
    worldDir: config.worldDir,
    commit,
  },
  input,
  config.autoAdvanceMax,
)) {
```

- [ ] **Step 2: 跑 server 測試**

```bash
cd app && npm test -- --reporter=verbose app
```

預期：全 PASS（`ServerDeps` 的舊測試不應破壞，`characterClient` 是 optional）

- [ ] **Step 3: Commit**

```bash
git add app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(server): 注入 characterClient 到 TurnDeps"
```

---

## Task 5：全套測試 + 收尾

- [ ] **Step 1: 跑全部測試**

```bash
cd app && npm test
```

預期：全 PASS，無 TypeScript 錯誤

- [ ] **Step 2: TypeScript 型別檢查**

```bash
cd app && npx tsc --noEmit
```

預期：無錯誤

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: scene pre-pass 實作完成，全測試通過"
```

- [ ] **Step 4: 開 PR**

```bash
gh pr create \
  --title "feat: Scene pre-pass — NPC 角色意圖注入敘事 system prompt" \
  --body "closes #7 的前置工作；實作 spec: docs/superpowers/specs/2026-06-19-scene-pre-pass-design.md"
```
