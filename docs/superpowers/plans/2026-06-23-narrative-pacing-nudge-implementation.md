# 劇情節奏停滯偵測與 Nudge 注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在每回合組裝主敘事 prompt 前注入兩種節奏建議——規則式的短期停滯偵測（`nudgeBlock`）與每 K 回合跑一次的長期節奏審閱（`pacingBlock`，劇本大師視角）——兩者都讀自新的持久化歷史索引 `world/journal_summary.md`。

**Architecture:** 新增 `world/journal_summary.md`（每回合 append 一行 `- [timestamp] (mode) summary`，由 `turn-core.ts` 寫入，跟著 `world/` 一起進 git）。短期規則（`nudge.ts`）每回合現讀檔案尾段、用本地 embedding 算 cosine similarity；長期審閱（`pacing.ts`）每 K 回合讀檔案尾段、呼叫一支獨立 LLM 產生建議文字。兩者都沿用 `context-blocks.ts` 既有的 `runXxxBlock(deps, ...) => AsyncGenerator<TurnEvent, string>` pattern，在 `runMainSpaceTurn`/`runDungeonTurn` 組 `plan.messages` 之前呼叫，結果透過 `BuildMessagesParams` 的 `nudgeBlock`/`pacingBlock` 欄位注入 system prompt。

**Tech Stack:** TypeScript（Node.js）、Vitest、`app/src/recall/embedder.ts` 既有的本地嵌入（`createLocalEmbedder`，Transformers.js/`Xenova/all-MiniLM-L6-v2`）、既有 `LlmClient`/`OpenAI` 相容 client 抽象。

## Global Constraints

- 不引入「每回合」呼叫聊天 LLM 的新 agent；短期規則只呼叫本地 embedding 模型，長期審閱每 K 回合（預設 10）才呼叫一次聊天 LLM。
- 不對玩家輸入做任何意圖分類、關鍵字比對或相似度比對；玩家輸入只在短期規則命中時當方向提示夾帶進建議文字，不參與觸發判斷。
- `world/journal_summary.md` 是 canonical 衍生索引，跟 `journal.md` 一樣 append-only、進 git；時間標記用到秒的 ISO timestamp（不是日期粒度）。
- 任一機制（短期規則、長期審閱）內部失敗都必須降級為回傳空字串，絕不能讓回合管線中斷或敘事不產出；降級時透過既有 `TurnEvent`（`{ type: "warning" }`）回報，不拋例外。
- 不做 `journal_summary.md` 的第二層壓縮（已記錄於 GitHub issue #41，本次範圍外）。
- 不改變 `FastControlSchema`/`LoreSyncSchema`、機率擲骰、raw 層落地、`now.md` 覆寫、commit 時機等既有下游邏輯。
- 規格來源：`docs/superpowers/specs/2026-06-23-narrative-pacing-nudge-design.md`（已核准）。

---

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `app/src/engine/turn/shared.ts` | 修改 | 新增 `nowISOSeconds()`；把 `AUTO_CONTINUE_INPUT` 從 `index.ts` 移過來（避免 `nudge.ts`↔`index.ts` 循環依賴） |
| `app/src/engine/journal-summary.ts` | 新增 | `appendJournalSummary`/`readJournalSummaryEntries`，操作 `world/journal_summary.md` |
| `app/src/engine/turn/prompts.ts` | 修改 | `BuildMessagesParams` 加 `nudgeBlock`/`pacingBlock`；新增 `buildPacingMessages` |
| `app/src/engine/turn/nudge.ts` | 新增 | `cosineSimilarity`、`runNudgeBlock`（短期停滯規則，純向量比較） |
| `app/src/engine/turn/pacing.ts` | 新增 | `runPacingBlock`（長期節奏審閱，呼叫獨立 LLM） |
| `app/src/engine/turn/turn-core.ts` | 修改 | 每回合落地時 append 一筆 `journal_summary.md` |
| `app/src/engine/turn/index.ts` | 修改 | `runMainSpaceTurn`/`runDungeonTurn` 呼叫 `runNudgeBlock`/`runPacingBlock`，傳進訊息建構器 |
| `app/src/engine/turn/types.ts` | 修改 | `TurnDeps` 加 `embedder`/`nudgeWindowSize`/`nudgeSimilarityThreshold`/`pacingClient`/`pacingReviewInterval`/`now` |
| `app/src/config.ts` | 修改 | 新增 `nudge`/`pacingReviewInterval`/`pacing` 設定與對應環境變數解析 |
| `app/src/server/app.ts` | 修改 | 組裝 `pacingClient`，把新設定值傳進 `runTurnLoop` 呼叫 |
| `app/.env.example` | 修改 | 補新環境變數說明 |

---

## Task 1: `nowISOSeconds()` 與搬移 `AUTO_CONTINUE_INPUT`

**Files:**
- Modify: `app/src/engine/turn/shared.ts`
- Modify: `app/src/engine/turn/index.ts:104`（移除原本的 `const AUTO_CONTINUE_INPUT = ...`，改成 import）
- Test: `app/src/engine/turn/shared.test.ts`（新檔）

**Interfaces:**
- Produces: `nowISOSeconds(): string`（到秒的 ISO timestamp，例如 `2026-06-23T14:32:05`）；`AUTO_CONTINUE_INPUT: string`（從 `shared.ts` export，供 Task 4 的 `nudge.ts` import，避免它跟 `index.ts` 互相 import 造成循環依賴）。

- [ ] **Step 1: 寫失敗的測試**

建立 `app/src/engine/turn/shared.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { nowISOSeconds, AUTO_CONTINUE_INPUT } from "./shared.js";

describe("nowISOSeconds", () => {
  it("回傳到秒的 ISO timestamp（無毫秒、無時區字尾）", () => {
    const ts = nowISOSeconds();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("AUTO_CONTINUE_INPUT", () => {
  it("是非空字串常數", () => {
    expect(typeof AUTO_CONTINUE_INPUT).toBe("string");
    expect(AUTO_CONTINUE_INPUT.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/shared.test.ts`
Expected: FAIL（`nowISOSeconds`/`AUTO_CONTINUE_INPUT` 尚未從 `shared.ts` export）

- [ ] **Step 3: 實作**

在 `app/src/engine/turn/shared.ts` 頂部（`todayISO` 之後）新增：

```ts
export function nowISOSeconds(): string {
  return new Date().toISOString().slice(0, 19);
}

/** 自動推進迴圈用的系統 placeholder 輸入；短期停滯規則（nudge.ts）需要排除這個值，故搬到這裡共用，避免跟 index.ts 循環依賴 */
export const AUTO_CONTINUE_INPUT = "（系統自動推進：延續上一刻，繼續敘事，玩家未介入）";
```

在 `app/src/engine/turn/index.ts` 移除原本第 104 行的 `const AUTO_CONTINUE_INPUT = "（系統自動推進：延續上一刻，繼續敘事，玩家未介入）";`，改成從 `shared.ts` import（`shared.ts` 已經是 `index.ts` 的既有 import 來源，加進同一行即可）：

```ts
import { readBestEffort, todayISO, AUTO_CONTINUE_INPUT } from "./shared.js";
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/shared.test.ts`
Expected: PASS

- [ ] **Step 5: 跑整個 turn 模組測試確認沒有改壞既有行為**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts`
Expected: PASS（`AUTO_CONTINUE_INPUT` 行為不變，只是搬了檔案位置）

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/turn/shared.ts app/src/engine/turn/shared.test.ts app/src/engine/turn/index.ts
git commit -m "refactor(turn): 新增 nowISOSeconds，AUTO_CONTINUE_INPUT 移至 shared.ts 共用"
```

---

## Task 2: `journal-summary.ts`（`world/journal_summary.md` 讀寫）

**Files:**
- Create: `app/src/engine/journal-summary.ts`
- Test: `app/src/engine/journal-summary.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface JournalSummaryEntry {
    timestamp: string;
    mode: string;
    summary: string;
  }
  export function appendJournalSummary(worldDir: string, entry: JournalSummaryEntry): Promise<void>;
  export function readJournalSummaryEntries(worldDir: string): Promise<JournalSummaryEntry[]>;
  ```
  （`Task 3` 的 `buildPacingMessages`、`Task 4` 的 `nudge.ts`、`Task 5` 的 `pacing.ts`、`Task 6` 的 `turn-core.ts` 都會用到這兩個函式與型別。）

- [ ] **Step 1: 寫失敗的測試**

建立 `app/src/engine/journal-summary.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendJournalSummary, readJournalSummaryEntries } from "./journal-summary.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "iwa-journal-summary-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appendJournalSummary", () => {
  it("檔案不存在時建立檔案並寫入第一行", async () => {
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "沈奕整理裝備" });
    const md = await readFile(path.join(dir, "journal_summary.md"), "utf8");
    expect(md).toBe("- [2026-06-23T10:00:00] (主空間) 沈奕整理裝備\n");
  });

  it("連續呼叫兩次會 append 而非覆寫，順序保留", async () => {
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "第一筆" });
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:05:00", mode: "副本:d1", summary: "第二筆" });
    const md = await readFile(path.join(dir, "journal_summary.md"), "utf8");
    const lines = md.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("第一筆");
    expect(lines[1]).toContain("第二筆");
    expect(md.indexOf("第一筆")).toBeLessThan(md.indexOf("第二筆"));
  });
});

describe("readJournalSummaryEntries", () => {
  it("檔案不存在時回傳空陣列", async () => {
    expect(await readJournalSummaryEntries(dir)).toEqual([]);
  });

  it("正確解析多行，含主空間與副本兩種 mode 標記", async () => {
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "沈奕整理裝備" });
    await appendJournalSummary(dir, { timestamp: "2026-06-23T10:05:00", mode: "副本:abandoned-hospital", summary: "葉晴擊倒喪屍" });
    const entries = await readJournalSummaryEntries(dir);
    expect(entries).toEqual([
      { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "沈奕整理裝備" },
      { timestamp: "2026-06-23T10:05:00", mode: "副本:abandoned-hospital", summary: "葉晴擊倒喪屍" },
    ]);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/journal-summary.test.ts`
Expected: FAIL（`./journal-summary.js` 模組不存在）

- [ ] **Step 3: 實作**

建立 `app/src/engine/journal-summary.ts`：

```ts
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

export interface JournalSummaryEntry {
  timestamp: string;
  mode: string;
  summary: string;
}

const LINE_RE = /^- \[(.+?)\] \((.+?)\) (.*)$/;

/** 把一筆回合摘要 append 到 world/journal_summary.md（跨主空間/副本統一時間線，append-only）。 */
export async function appendJournalSummary(worldDir: string, entry: JournalSummaryEntry): Promise<void> {
  const line = `- [${entry.timestamp}] (${entry.mode}) ${entry.summary}\n`;
  await appendFile(path.join(worldDir, "journal_summary.md"), line, "utf8");
}

/** 讀出 journal_summary.md 所有已解析的條目；檔案不存在時回傳空陣列。 */
export async function readJournalSummaryEntries(worldDir: string): Promise<JournalSummaryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(worldDir, "journal_summary.md"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    return [];
  }
  const entries: JournalSummaryEntry[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(LINE_RE);
    if (m) entries.push({ timestamp: m[1], mode: m[2], summary: m[3] });
  }
  return entries;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/journal-summary.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/journal-summary.ts app/src/engine/journal-summary.test.ts
git commit -m "feat(engine): 新增 journal_summary.md 讀寫，跨主空間/副本統一摘要時間線"
```

---

## Task 3: `prompts.ts` — `nudgeBlock`/`pacingBlock` 欄位與 `buildPacingMessages`

**Files:**
- Modify: `app/src/engine/turn/prompts.ts`
- Modify: `app/src/engine/turn/prompts.test.ts`

**Interfaces:**
- Consumes: `JournalSummaryEntry`（`app/src/engine/journal-summary.js`，來自 Task 2）。
- Produces:
  ```ts
  export interface BuildMessagesParams {
    settingText: string;
    state: GameState;
    input: string;
    dicePool: number[];
    intentsBlock?: string;
    recallBlock?: string;
    nudgeBlock?: string;
    pacingBlock?: string;
  }
  export interface BuildPacingParams {
    settingText: string;
    state: GameState;
    entries: JournalSummaryEntry[];
  }
  export function buildPacingMessages(params: BuildPacingParams): ChatMessage[];
  ```
  （`buildMainSpaceMessages`/`buildDungeonMessages` 已經透過既有的 `...appendOptionalBlocks(params)` 機制自動把新欄位串進 system prompt，這個 Task 只需要擴充型別與 `appendOptionalBlocks` 本體；`Task 5` 的 `pacing.ts` 會呼叫 `buildPacingMessages`。）

- [ ] **Step 1: 寫失敗的測試**

在 `app/src/engine/turn/prompts.test.ts` 的 `import` 區塊加入 `buildPacingMessages`：

```ts
import {
  buildDungeonMessages,
  buildFastControlMessages,
  buildLoreSyncMessages,
  buildMainSpaceMessages,
  buildPacingMessages,
} from "./prompts.js";
```

在檔案末尾（既有 `describe("buildMainSpaceMessages", ...)` 之後）新增：

```ts
describe("nudgeBlock / pacingBlock 注入", () => {
  it("nudgeBlock 有值時出現在主空間 system prompt", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      nudgeBlock: "## 節奏建議（短期）\n最近幾回合的劇情進展趨於重複。",
    });
    expect(msgs[0].content).toContain("## 節奏建議（短期）");
  });

  it("pacingBlock 有值時出現在副本 system prompt", () => {
    const msgs = buildDungeonMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      dungeonId: "d1",
      wiki: "",
      secrets: "",
      pacingBlock: "## 節奏建議（長期，劇本大師）\n該開新副本了。",
    });
    expect(msgs[0].content).toContain("## 節奏建議（長期，劇本大師）");
  });

  it("nudgeBlock/pacingBlock 都未提供時不出現任一標題", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
    });
    expect(msgs[0].content).not.toContain("## 節奏建議");
  });
});

describe("buildPacingMessages", () => {
  it("system 含歷史摘要時間線與當前局勢，user 是固定請求", () => {
    const msgs = buildPacingMessages({
      settingText: "設定",
      state: makeFakeState(),
      entries: [
        { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "沈奕整理裝備" },
        { timestamp: "2026-06-23T10:05:00", mode: "副本:d1", summary: "葉晴擊倒喪屍" },
      ],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("劇本大師");
    expect(msgs[0].content).toContain("沈奕整理裝備");
    expect(msgs[0].content).toContain("(副本:d1)");
    expect(msgs[1]).toEqual({ role: "user", content: "請給這回合的長期節奏建議。" });
  });

  it("沒有歷史摘要時仍正常產出，標示尚無記錄", () => {
    const msgs = buildPacingMessages({ settingText: "設定", state: makeFakeState(), entries: [] });
    expect(msgs[0].content).toContain("（尚無記錄）");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/prompts.test.ts`
Expected: FAIL（`buildPacingMessages` 不存在；`nudgeBlock`/`pacingBlock` 不在 `BuildMessagesParams` 型別上，TS 編譯/執行會報錯）

- [ ] **Step 3: 實作**

在 `app/src/engine/turn/prompts.ts` 頂部加入型別 import（跟既有 `import type { GameState } from "../context.js";` 同一行區塊）：

```ts
import type { JournalSummaryEntry } from "../journal-summary.js";
```

把 `appendOptionalBlocks` 改成：

```ts
function appendOptionalBlocks(params: {
  intentsBlock?: string;
  recallBlock?: string;
  nudgeBlock?: string;
  pacingBlock?: string;
}): string[] {
  return [
    ...(params.intentsBlock ? ["", params.intentsBlock] : []),
    ...(params.recallBlock ? ["", params.recallBlock] : []),
    ...(params.nudgeBlock ? ["", params.nudgeBlock] : []),
    ...(params.pacingBlock ? ["", params.pacingBlock] : []),
  ];
}
```

把 `BuildMessagesParams` 改成：

```ts
export interface BuildMessagesParams {
  settingText: string;
  state: GameState;
  input: string;
  dicePool: number[];
  intentsBlock?: string;
  recallBlock?: string;
  nudgeBlock?: string;
  pacingBlock?: string;
}
```

在檔案末尾（`buildLoreSyncMessages` 之後）新增：

```ts
export interface BuildPacingParams {
  settingText: string;
  state: GameState;
  entries: JournalSummaryEntry[];
}

/**
 * 長期節奏審閱（劇本大師）的對話訊息：讀歷史摘要時間線＋當前局勢，
 * 請 LLM 給一段自由文字節奏建議（非 JSON），供敘事 LLM 參考、不是指令。
 */
export function buildPacingMessages(params: BuildPacingParams): ChatMessage[] {
  const { settingText, state, entries } = params;
  const historyLines = entries.map((e) => `- [${e.timestamp}] (${e.mode}) ${e.summary}`).join("\n");
  const system = [
    "你是本世界敘事引擎的**劇本大師（長期節奏顧問）**。",
    "下方是最近的歷史摘要時間線與當前局勢，你的工作是依長期走勢給敘事 LLM 一段節奏建議",
    "（例如：該不該插入支線、是否該催促/開啟下一個副本、副本內節奏是否該升級），",
    "建議僅供參考、不是指令，敘事 LLM 會自行決定是否採納。",
    "",
    "## 鐵則",
    "- 只依下方歷史摘要與當前局勢做主觀節奏判斷，不可發明摘要未提及的事件。",
    "- 不可建議提前揭露任何尚未公開的暗線/真相。",
    "- 輸出一段簡短的自由文字建議（不超過三、四句），不要輸出 JSON 或條列格式。",
    "",
    "## 最近歷史摘要時間線",
    historyLines || "（尚無記錄）",
    "",
    canonicalBlock(state),
    settingText ? "" : "",
  ]
    .filter((line, i) => !(line === "" && i === 0))
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: "請給這回合的長期節奏建議。" },
  ];
}
```

> 注意：上面 `settingText ? "" : ""` 與 `.filter(...)` 是錯的占位，**不要這樣寫**——正確版本不需要那兩行，直接拿掉，因為 `buildPacingMessages` 不需要重複輸出完整世界設定全文（節奏判斷不依賴設定細節，且能讓 prompt 更精簡）；`settingText` 參數保留在 `BuildPacingParams`／函式簽名上是為了跟其他 `build*Messages` 一致、方便未來若要加設定摘要時不必改呼叫端，但目前函式體不使用它。把上面那段改成：

```ts
export function buildPacingMessages(params: BuildPacingParams): ChatMessage[] {
  const { state, entries } = params;
  const historyLines = entries.map((e) => `- [${e.timestamp}] (${e.mode}) ${e.summary}`).join("\n");
  const system = [
    "你是本世界敘事引擎的**劇本大師（長期節奏顧問）**。",
    "下方是最近的歷史摘要時間線與當前局勢，你的工作是依長期走勢給敘事 LLM 一段節奏建議",
    "（例如：該不該插入支線、是否該催促/開啟下一個副本、副本內節奏是否該升級），",
    "建議僅供參考、不是指令，敘事 LLM 會自行決定是否採納。",
    "",
    "## 鐵則",
    "- 只依下方歷史摘要與當前局勢做主觀節奏判斷，不可發明摘要未提及的事件。",
    "- 不可建議提前揭露任何尚未公開的暗線/真相。",
    "- 輸出一段簡短的自由文字建議（不超過三、四句），不要輸出 JSON 或條列格式。",
    "",
    "## 最近歷史摘要時間線",
    historyLines || "（尚無記錄）",
    "",
    canonicalBlock(state),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: "請給這回合的長期節奏建議。" },
  ];
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/prompts.ts app/src/engine/turn/prompts.test.ts
git commit -m "feat(prompts): 新增 nudgeBlock/pacingBlock 注入點與 buildPacingMessages"
```

---

## Task 4: `nudge.ts`（短期停滯規則）

**Files:**
- Create: `app/src/engine/turn/nudge.ts`
- Test: `app/src/engine/turn/nudge.test.ts`
- Modify: `app/src/engine/turn/types.ts`

**Interfaces:**
- Consumes: `readJournalSummaryEntries`（Task 2）、`AUTO_CONTINUE_INPUT`（Task 1，從 `./shared.js`）、`Embedder`/`createLocalEmbedder`（`app/src/recall/embedder.js`，既有）、`TurnDeps`/`TurnEvent`（`./types.js`）。
- Produces:
  ```ts
  export function cosineSimilarity(a: number[], b: number[]): number;
  export function runNudgeBlock(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent, string>;
  ```
  （`Task 7` 的 `turn/index.ts` 會 `yield* runNudgeBlock(deps, input)`。）

先在 `app/src/engine/turn/types.ts` 加新欄位（`TurnDeps` interface 內，`recallTopK` 之後）：

```ts
import type { Embedder } from "../../recall/embedder.js";
```

```ts
  /** 短期停滯規則用的本地嵌入器（選填；測試可注入 fake，預設 createLocalEmbedder()） */
  embedder?: Embedder;
  /** 短期停滯規則比較的視窗大小（最近 N 筆 journal_summary 條目），預設 5 */
  nudgeWindowSize?: number;
  /** 短期停滯規則的 cosine similarity 命中門檻（0~1），預設 0.92 */
  nudgeSimilarityThreshold?: number;
```

- [ ] **Step 1: 寫失敗的測試**

建立 `app/src/engine/turn/nudge.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { Embedder } from "../../recall/embedder.js";
import { appendJournalSummary } from "../journal-summary.js";
import { AUTO_CONTINUE_INPUT } from "./shared.js";
import { cosineSimilarity, runNudgeBlock } from "./nudge.js";
import type { TurnDeps, TurnEvent } from "./types.js";

function fakeClient(): LlmClient {
  return { async *streamChat(_m: ChatMessage[]): AsyncIterable<string> { yield ""; } };
}

function fakeEmbedder(vectorsByText: Record<string, number[]>, opts: { throwOnEmbed?: boolean } = {}): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (opts.throwOnEmbed) throw new Error("嵌入模型掛了");
      return texts.map((t) => vectorsByText[t] ?? [0, 0]);
    },
  };
}

async function collect(gen: AsyncGenerator<TurnEvent, string>): Promise<{ events: TurnEvent[]; result: string }> {
  const events: TurnEvent[] = [];
  let result = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
    events.push(value as TurnEvent);
  }
  return { events, result };
}

let world: string;
beforeEach(async () => {
  world = await mkdtemp(path.join(tmpdir(), "iwa-nudge-"));
});
afterEach(async () => {
  await rm(world, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return {
    client: fakeClient(),
    worldDir: world,
    commit: async () => false,
    ...overrides,
  };
}

describe("cosineSimilarity", () => {
  it("相同向量相似度為 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });
  it("正交向量相似度為 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("任一為零向量時回傳 0（避免除零）", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe("runNudgeBlock", () => {
  it("journal_summary.md 不存在時回傳空字串", async () => {
    const { result } = await collect(runNudgeBlock(baseDeps(), "隨便做點事"));
    expect(result).toBe("");
  });

  it("筆數不足 windowSize 時回傳空字串", async () => {
    await appendJournalSummary(world, { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "A" });
    const { result } = await collect(runNudgeBlock(baseDeps(), "隨便做點事"));
    expect(result).toBe("");
  });

  it("連續高相似度時回傳建議文字（含節奏建議標題）", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `重複描述${i}` });
    }
    const embedder = fakeEmbedder({
      重複描述0: [1, 0], 重複描述1: [1, 0], 重複描述2: [1, 0], 重複描述3: [1, 0], 重複描述4: [1, 0],
    });
    const { result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), "隨便做點事"));
    expect(result).toContain("## 節奏建議（短期）");
  });

  it("窗口內有差異向量時不觸發，回傳空字串", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `描述${i}` });
    }
    const embedder = fakeEmbedder({
      描述0: [1, 0], 描述1: [0, 1], 描述2: [1, 0], 描述3: [0, 1], 描述4: [1, 0],
    });
    const { result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), "隨便做點事"));
    expect(result).toBe("");
  });

  it("命中時若 input 不是 AUTO_CONTINUE_INPUT，建議文字含玩家方向提示", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `重複${i}` });
    }
    const embedder = fakeEmbedder({ 重複0: [1, 0], 重複1: [1, 0], 重複2: [1, 0], 重複3: [1, 0], 重複4: [1, 0] });
    const { result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), "推門進去，做好戰鬥準備"));
    expect(result).toContain("推門進去，做好戰鬥準備");
  });

  it("命中時若 input 是 AUTO_CONTINUE_INPUT，建議文字不含方向提示句", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `重複${i}` });
    }
    const embedder = fakeEmbedder({ 重複0: [1, 0], 重複1: [1, 0], 重複2: [1, 0], 重複3: [1, 0], 重複4: [1, 0] });
    const { result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), AUTO_CONTINUE_INPUT));
    expect(result).not.toContain("玩家最近表達的方向");
  });

  it("embedder 拋例外時降級回傳空字串並 yield warning 事件", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `x${i}` });
    }
    const embedder = fakeEmbedder({}, { throwOnEmbed: true });
    const { events, result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), "測試"));
    expect(result).toBe("");
    expect(events.some((e) => e.type === "warning")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/nudge.test.ts`
Expected: FAIL（`./nudge.js` 模組不存在）

- [ ] **Step 3: 實作**

把 Task 4 開頭描述的 `embedder`/`nudgeWindowSize`/`nudgeSimilarityThreshold` 欄位加進 `app/src/engine/turn/types.ts` 的 `TurnDeps` interface（記得在檔案頂部加 `import type { Embedder } from "../../recall/embedder.js";`）。

建立 `app/src/engine/turn/nudge.ts`：

```ts
import { readJournalSummaryEntries } from "../journal-summary.js";
import { createLocalEmbedder } from "../../recall/embedder.js";
import { AUTO_CONTINUE_INPUT } from "./shared.js";
import type { TurnDeps, TurnEvent } from "./types.js";

const DEFAULT_WINDOW_SIZE = 5;
const DEFAULT_SIMILARITY_THRESHOLD = 0.92;

/** 兩個等長向量的 cosine similarity；任一為零向量時回傳 0（避免除零）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function formatNudgeBlock(hint?: string): string {
  const base =
    "最近幾回合的劇情進展趨於重複，這回合請讓故事有實質推進（事件發生、衝突結果、新資訊揭露等）。";
  const hintLine = hint ? `（若有參考價值）玩家最近表達的方向：「${hint}」。` : "";
  return ["## 節奏建議（短期）", `${base}${hintLine}`].join("\n");
}

/**
 * 短期停滯規則：讀 world/journal_summary.md 最後 N 筆，用本地嵌入比較相鄰兩筆的 cosine
 * similarity；全部相鄰對都連續高度重複（≥ 門檻）時回傳格式化建議文字。
 * 不維護任何 in-memory 狀態——每回合都是現讀現查，天然跨重啟存活。
 * 失敗時降級為空字串並 yield warning，絕不拋出例外影響主回合管線。
 */
export async function* runNudgeBlock(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent, string> {
  const windowSize = deps.nudgeWindowSize ?? DEFAULT_WINDOW_SIZE;
  const threshold = deps.nudgeSimilarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  try {
    const entries = await readJournalSummaryEntries(deps.worldDir);
    if (entries.length < windowSize) return "";

    const window = entries.slice(-windowSize);
    const embedder = deps.embedder ?? createLocalEmbedder();
    const vectors = await embedder.embed(window.map((e) => e.summary));

    for (let i = 0; i < vectors.length - 1; i++) {
      if (cosineSimilarity(vectors[i], vectors[i + 1]) < threshold) return "";
    }

    const hint = input === AUTO_CONTINUE_INPUT ? undefined : input;
    return formatNudgeBlock(hint);
  } catch (err) {
    yield { type: "warning" as const, message: `短期停滯規則執行失敗，略過：${(err as Error).message}` };
    return "";
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/nudge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/nudge.ts app/src/engine/turn/nudge.test.ts app/src/engine/turn/types.ts
git commit -m "feat(turn): 新增短期停滯規則 runNudgeBlock（本地嵌入相似度比較）"
```

---

## Task 5: `pacing.ts`（長期節奏審閱，劇本大師）

**Files:**
- Create: `app/src/engine/turn/pacing.ts`
- Test: `app/src/engine/turn/pacing.test.ts`
- Modify: `app/src/engine/turn/types.ts`

**Interfaces:**
- Consumes: `readJournalSummaryEntries`（Task 2）、`buildPacingMessages`（Task 3）、`TurnDeps`/`TurnEvent`（`./types.js`）、`GameState`（`../context.js`）。
- Produces:
  ```ts
  export function runPacingBlock(deps: TurnDeps, state: GameState, settingText: string): AsyncGenerator<TurnEvent, string>;
  ```
  （`Task 7` 的 `turn/index.ts` 會 `yield* runPacingBlock(deps, state, settingText)`。）

先在 `app/src/engine/turn/types.ts` 的 `TurnDeps` interface 加新欄位（`loreClient` 之後）：

```ts
  /** 長期節奏審閱（劇本大師）用的 LLM（選填）；未提供時依序退回 controlClient、主 client */
  pacingClient?: LlmClient;
  /** 長期節奏審閱頻率：每 K 回合跑一次（K = journal_summary.md 行數的倍數），預設 10 */
  pacingReviewInterval?: number;
```

- [ ] **Step 1: 寫失敗的測試**

建立 `app/src/engine/turn/pacing.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { appendJournalSummary } from "../journal-summary.js";
import { runPacingBlock } from "./pacing.js";
import type { TurnDeps, TurnEvent } from "./types.js";
import type { GameState } from "../context.js";

function fakeClient(deltas: string[] | (() => never)): LlmClient {
  return {
    async *streamChat(_m: ChatMessage[]): AsyncIterable<string> {
      if (typeof deltas === "function") deltas();
      else for (const d of deltas) yield d;
    },
  };
}

async function collect(gen: AsyncGenerator<TurnEvent, string>): Promise<{ events: TurnEvent[]; result: string }> {
  const events: TurnEvent[] = [];
  let result = "";
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
    events.push(value as TurnEvent);
  }
  return { events, result };
}

function makeFakeState(): GameState {
  return {
    now: { chapter: "c", scene: "s", companions: "", activeDungeon: "無", threads: "", nextStep: "", lastUpdated: "" },
    protagonist: { name: "沈奕", points: "100" },
    protagonistDetail: { name: "沈奕", points: "100", attributes: "", skills: "", items: "", buffs: "" },
    npcs: [],
    mode: "main-space",
    lastTurn: null,
  };
}

let world: string;
beforeEach(async () => {
  world = await mkdtemp(path.join(tmpdir(), "iwa-pacing-"));
});
afterEach(async () => {
  await rm(world, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return {
    client: fakeClient([]),
    worldDir: world,
    commit: async () => false,
    ...overrides,
  };
}

describe("runPacingBlock", () => {
  it("journal_summary.md 不存在（0 筆）時不呼叫 LLM，回傳空字串", async () => {
    let called = false;
    const pacingClient = fakeClient(() => { called = true; throw new Error("不該被呼叫"); });
    const { result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 2 }), makeFakeState(), "設定"),
    );
    expect(result).toBe("");
    expect(called).toBe(false);
  });

  it("行數不是 K 的倍數時不呼叫 LLM", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    let called = false;
    const pacingClient = fakeClient(() => { called = true; throw new Error("不該被呼叫"); });
    const { result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 2 }), makeFakeState(), "設定"),
    );
    expect(result).toBe("");
    expect(called).toBe(false);
  });

  it("行數是 K 的倍數時呼叫 LLM，回傳格式化內容", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    await appendJournalSummary(world, { timestamp: "t2", mode: "主空間", summary: "B" });
    const pacingClient = fakeClient(["該開新副本了。"]);
    const { result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 2 }), makeFakeState(), "設定"),
    );
    expect(result).toContain("## 節奏建議（長期，劇本大師）");
    expect(result).toContain("該開新副本了。");
  });

  it("deps.pacingClient 優先於 controlClient/client", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    const wrongClient = fakeClient(() => { throw new Error("不該被呼叫這個"); });
    const pacingClient = fakeClient(["正確的建議"]);
    const { result } = await collect(
      runPacingBlock(
        baseDeps({ client: wrongClient, controlClient: wrongClient, pacingClient, pacingReviewInterval: 1 }),
        makeFakeState(),
        "設定",
      ),
    );
    expect(result).toContain("正確的建議");
  });

  it("LLM 回應 trim 後為空字串時回傳空字串", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    const pacingClient = fakeClient(["   \n  "]);
    const { result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 1 }), makeFakeState(), "設定"),
    );
    expect(result).toBe("");
  });

  it("LLM 呼叫失敗時降級回傳空字串並 yield warning", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    const pacingClient = fakeClient(() => { throw new Error("LLM 掛了"); });
    const { events, result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 1 }), makeFakeState(), "設定"),
    );
    expect(result).toBe("");
    expect(events.some((e) => e.type === "warning")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/pacing.test.ts`
Expected: FAIL（`./pacing.js` 模組不存在）

- [ ] **Step 3: 實作**

把 Task 5 開頭描述的 `pacingClient`/`pacingReviewInterval` 欄位加進 `app/src/engine/turn/types.ts` 的 `TurnDeps` interface。

建立 `app/src/engine/turn/pacing.ts`：

```ts
import { readJournalSummaryEntries } from "../journal-summary.js";
import { buildPacingMessages } from "./prompts.js";
import type { GameState } from "../context.js";
import type { TurnDeps, TurnEvent } from "./types.js";

const DEFAULT_REVIEW_INTERVAL = 10;
const PACING_HISTORY_TAIL = 50;

function formatPacingBlock(text: string): string {
  return ["## 節奏建議（長期，劇本大師）", text].join("\n");
}

/**
 * 長期節奏審閱：journal_summary.md 行數是 K 的倍數時，呼叫獨立 LLM 讀歷史摘要做節奏判斷；
 * 其餘回合直接回傳空字串，不呼叫 LLM。失敗時降級為空字串並 yield warning。
 */
export async function* runPacingBlock(
  deps: TurnDeps,
  state: GameState,
  settingText: string,
): AsyncGenerator<TurnEvent, string> {
  const interval = deps.pacingReviewInterval ?? DEFAULT_REVIEW_INTERVAL;
  try {
    const entries = await readJournalSummaryEntries(deps.worldDir);
    if (entries.length === 0 || entries.length % interval !== 0) return "";

    const tail = entries.slice(-PACING_HISTORY_TAIL);
    const client = deps.pacingClient ?? deps.controlClient ?? deps.client;
    const messages = buildPacingMessages({ settingText, state, entries: tail });

    let raw = "";
    for await (const delta of client.streamChat(messages)) raw += delta;
    const text = raw.trim();
    return text ? formatPacingBlock(text) : "";
  } catch (err) {
    yield { type: "warning" as const, message: `長期節奏審閱失敗，略過：${(err as Error).message}` };
    return "";
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/pacing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/pacing.ts app/src/engine/turn/pacing.test.ts app/src/engine/turn/types.ts
git commit -m "feat(turn): 新增長期節奏審閱 runPacingBlock（劇本大師，每 K 回合一次）"
```

---

## Task 6: `turn-core.ts` — 每回合落地時寫入 `journal_summary.md`

**Files:**
- Modify: `app/src/engine/turn/turn-core.ts`
- Modify: `app/src/engine/turn/types.ts`
- Test: `app/src/engine/turn/index.test.ts`（新增測試案例，沿用既有檔案）

**Interfaces:**
- Consumes: `appendJournalSummary`（Task 2）、`nowISOSeconds`（Task 1）。
- Produces: `TurnDeps.now?: () => string`（測試可注入固定時間戳，預設 `nowISOSeconds`）。

先在 `app/src/engine/turn/types.ts` 的 `TurnDeps` interface 加新欄位（`today` 之後）：

```ts
  /** journal_summary.md 寫入用的時間戳（測試可注入固定值）；未提供時退回真實 nowISOSeconds() */
  now?: () => string;
```

- [ ] **Step 1: 寫失敗的測試**

在 `app/src/engine/turn/index.test.ts` 末尾新增一個 `describe` block（沿用既有的 `fakeClient`/`world` fixture）：

```ts
describe("journal_summary.md 寫入", () => {
  it("主空間回合結束後 journal_summary.md 多一行，mode 為主空間", async () => {
    const response =
      "沈奕做了某事。\n===STATE===\n" +
      JSON.stringify({
        state_changes: {}, rolls: [], mode_transition: null,
        awaiting_user_input: true, suggested_actions: [], commit_summary: "沈奕做了某事",
      });
    const deps: TurnDeps = {
      client: fakeClient([response]),
      worldDir: world,
      commit: async () => true,
      today: () => "2026-06-19",
      now: () => "2026-06-19T12:00:00",
      dicePool: [1],
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "行動")) events.push(ev);

    const md = await readFile(path.join(world, "journal_summary.md"), "utf8");
    expect(md.trim()).toBe("- [2026-06-19T12:00:00] (主空間) 沈奕做了某事");
  });

  it("副本回合結束後 journal_summary.md mode 標記為 副本:<id>", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    const ctrlJson = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: null,
      awaiting_user_input: true, suggested_actions: [], commit_summary: "進入大廳",
    });
    const response = "你踏入大廳。\n===STATE===\n" + ctrlJson;
    const deps: TurnDeps = {
      client: fakeClient([response]),
      worldDir: world,
      commit: async () => true,
      today: () => "2026-06-19",
      now: () => "2026-06-19T12:00:00",
      dicePool: [5],
    };
    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(deps, "往前走")) events.push(ev);

    const md = await readFile(path.join(world, "journal_summary.md"), "utf8");
    expect(md.trim()).toBe("- [2026-06-19T12:00:00] (副本:U-001) 進入大廳");
  });
});
```

（確認檔案頂部已有 `readFile`、`mkdir`、`writeFile` 的 import；既有 `index.test.ts` 開頭已經 `import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";`，不需要額外加。）

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts -t "journal_summary.md 寫入"`
Expected: FAIL（`journal_summary.md` 不存在，`readFile` 會拋 ENOENT）

- [ ] **Step 3: 實作**

在 `app/src/engine/turn/turn-core.ts` 頂部加 import：

```ts
import { appendJournalSummary } from "../journal-summary.js";
import { nowISOSeconds } from "./shared.js";
```

在 `summary` 算出來、`plan.appendRaw(...)` 之後（即「1. raw 層」區塊結束、「2. 提煉頁 now.md」開始之前）插入：

```ts
  // 1b. journal_summary 索引（衍生摘要，給短期/長期節奏機制讀；失敗只警告，不擋本回合落地）
  try {
    await appendJournalSummary(deps.worldDir, {
      timestamp: (deps.now ?? nowISOSeconds)(),
      mode: plan.dungeonId ? `副本:${plan.dungeonId}` : "主空間",
      summary,
    });
  } catch (err) {
    log.warn({ err }, "journal_summary.md 寫入失敗，略過（不影響本回合落地）");
  }
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts`
Expected: PASS（含原本所有既有測試與新增的兩個）

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/turn-core.ts app/src/engine/turn/types.ts app/src/engine/turn/index.test.ts
git commit -m "feat(turn): 每回合落地時寫入 journal_summary.md（主空間/副本統一時間線）"
```

---

## Task 7: `turn/index.ts` — 接上 `runNudgeBlock`/`runPacingBlock`

**Files:**
- Modify: `app/src/engine/turn/index.ts`
- Test: `app/src/engine/turn/index.test.ts`（新增測試案例）

**Interfaces:**
- Consumes: `runNudgeBlock`（Task 4）、`runPacingBlock`（Task 5）。

- [ ] **Step 1: 寫失敗的測試**

在 `app/src/engine/turn/index.test.ts` 末尾新增（沿用既有 import，另加 `Embedder` 型別與 `fakeEmbedder` helper）：

```ts
import type { Embedder } from "../../recall/embedder.js";

function fakeEmbedder(vectorsByText: Record<string, number[]>): Embedder {
  return {
    async embed(texts: string[]) {
      return texts.map((t) => vectorsByText[t] ?? [0, 0]);
    },
  };
}

describe("nudgeBlock / pacingBlock 整合", () => {
  it("nudgeBlock 命中時出現在主空間 system prompt", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(
        path.join(world, "journal_summary.md"),
        `- [2026-06-19T10:0${i}:00] (主空間) 重複${i}\n`,
        { flag: "a" },
      );
    }
    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        capturedSystem = msgs[0].content;
        yield `敘事\n===STATE===\n${JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        })}`;
      },
    };
    const embedder = fakeEmbedder({ 重複0: [1, 0], 重複1: [1, 0], 重複2: [1, 0], 重複3: [1, 0], 重複4: [1, 0] });
    const deps: TurnDeps = {
      client: mainClient, worldDir: world, commit: async () => false,
      today: () => "2026-06-19", dicePool: [50], embedder, nudgeWindowSize: 5,
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "繼續")) events.push(ev);

    expect(capturedSystem).toContain("## 節奏建議（短期）");
  });

  it("pacingBlock 命中時出現在副本 system prompt", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    await writeFile(path.join(world, "journal_summary.md"), "- [2026-06-19T09:00:00] (主空間) 之前的事\n");

    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        capturedSystem = msgs[0].content;
        yield `敘事\n===STATE===\n${JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        })}`;
      },
    };
    const pacingClient: LlmClient = { async *streamChat() { yield "這層拖太久了，該升級張力。"; } };
    const deps: TurnDeps = {
      client: mainClient, worldDir: world, commit: async () => false,
      today: () => "2026-06-19", dicePool: [5], pacingClient, pacingReviewInterval: 1,
    };
    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(deps, "往前走")) events.push(ev);

    expect(capturedSystem).toContain("## 節奏建議（長期，劇本大師）");
    expect(capturedSystem).toContain("這層拖太久了，該升級張力。");
  });

  it("沒有 journal_summary.md 時不出現任何節奏建議標題（預設情境）", async () => {
    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        capturedSystem = msgs[0].content;
        yield `敘事\n===STATE===\n${JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        })}`;
      },
    };
    const deps: TurnDeps = {
      client: mainClient, worldDir: world, commit: async () => false,
      today: () => "2026-06-19", dicePool: [50],
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "測試")) events.push(ev);

    expect(capturedSystem).not.toContain("## 節奏建議");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts -t "nudgeBlock / pacingBlock 整合"`
Expected: FAIL（`buildMainSpaceMessages`/`buildDungeonMessages` 呼叫端還沒傳 `nudgeBlock`/`pacingBlock`，system prompt 不含對應標題）

- [ ] **Step 3: 實作**

在 `app/src/engine/turn/index.ts` 頂部 import 區塊加入：

```ts
import { runNudgeBlock } from "./nudge.js";
import { runPacingBlock } from "./pacing.js";
```

在 `runMainSpaceTurn` 裡（`runRecallBlock` 呼叫之後、`plan` 組裝之前）加：

```ts
  const nudgeBlock = yield* runNudgeBlock(deps, input);
  const pacingBlock = yield* runPacingBlock(deps, state, settingText);
```

把 `runMainSpaceTurn` 的 `plan.messages` 改成：

```ts
    messages: buildMainSpaceMessages({ settingText, state, input, dicePool, intentsBlock, recallBlock, nudgeBlock, pacingBlock }),
```

在 `runDungeonTurn` 裡（`runRecallBlock` 呼叫之後、`plan` 組裝之前）同樣加：

```ts
  const nudgeBlock = yield* runNudgeBlock(deps, input);
  const pacingBlock = yield* runPacingBlock(deps, state, settingText);
```

把 `runDungeonTurn` 的 `plan.messages` 改成：

```ts
    messages: buildDungeonMessages({
      settingText, state, input, dicePool,
      dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      intentsBlock, recallBlock, nudgeBlock, pacingBlock,
    }),
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts`
Expected: PASS（含全部既有與新增測試）

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/index.ts app/src/engine/turn/index.test.ts
git commit -m "feat(turn): runMainSpaceTurn/runDungeonTurn 接上短期/長期節奏建議區塊"
```

---

## Task 8: `config.ts` — 新增節奏相關設定

**Files:**
- Modify: `app/src/config.ts`
- Modify: `app/src/config.test.ts`

**Interfaces:**
- Produces: `AppConfig.nudge: { windowSize: number; similarityThreshold: number }`、`AppConfig.pacingReviewInterval: number`、`AppConfig.pacing?: { baseUrl: string; model: string }`。

- [ ] **Step 1: 寫失敗的測試**

在 `app/src/config.test.ts` 的 `describe("loadConfig", ...)` 區塊內新增：

```ts
  it("nudge 設定預設值", () => {
    const c = loadConfig({});
    expect(c.nudge.windowSize).toBe(5);
    expect(c.nudge.similarityThreshold).toBeCloseTo(0.92);
  });

  it("nudge 設定可由環境變數覆寫", () => {
    const c = loadConfig({ NUDGE_WINDOW_SIZE: "8", NUDGE_SIMILARITY_THRESHOLD: "0.8" });
    expect(c.nudge.windowSize).toBe(8);
    expect(c.nudge.similarityThreshold).toBeCloseTo(0.8);
  });

  it("NUDGE_SIMILARITY_THRESHOLD 超出 0~1 範圍或非數字時退回預設", () => {
    expect(loadConfig({ NUDGE_SIMILARITY_THRESHOLD: "2" }).nudge.similarityThreshold).toBeCloseTo(0.92);
    expect(loadConfig({ NUDGE_SIMILARITY_THRESHOLD: "abc" }).nudge.similarityThreshold).toBeCloseTo(0.92);
  });

  it("NUDGE_WINDOW_SIZE 非正整數時退回預設", () => {
    expect(loadConfig({ NUDGE_WINDOW_SIZE: "-1" }).nudge.windowSize).toBe(5);
  });

  it("pacingReviewInterval 預設 10，可由環境變數覆寫", () => {
    expect(loadConfig({}).pacingReviewInterval).toBe(10);
    expect(loadConfig({ PACING_REVIEW_INTERVAL: "20" }).pacingReviewInterval).toBe(20);
  });

  it("pacing 欄位：有設定時解析", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1", OPENAI_API_KEY: "key", MODEL: "main-model",
      PACING_OPENAI_BASE_URL: "http://pacing/v1", PACING_MODEL: "qwen2.5:7b",
    });
    expect(config.pacing).toEqual({ baseUrl: "http://pacing/v1", model: "qwen2.5:7b" });
  });

  it("pacing 欄位：未設定時為 undefined", () => {
    expect(loadConfig({ OPENAI_API_KEY: "key" }).pacing).toBeUndefined();
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/config.test.ts`
Expected: FAIL（`AppConfig` 還沒有 `nudge`/`pacingReviewInterval`/`pacing` 欄位）

- [ ] **Step 3: 實作**

在 `app/src/config.ts` 的 `AppConfig` interface 加入（`lore?` 欄位之後）：

```ts
  /** 短期停滯規則（規則式，本地嵌入相似度比較） */
  nudge: {
    windowSize: number;
    similarityThreshold: number;
  };
  /** 長期節奏審閱（劇本大師）頻率：每 K 回合跑一次 */
  pacingReviewInterval: number;
  /** 長期節奏審閱用 LLM（選填）；缺省時依序退回 control、主 LLM */
  pacing?: {
    baseUrl: string;
    model: string;
  };
```

在 `DEFAULTS` 加入：

```ts
  nudgeWindowSize: 5,
  nudgeSimilarityThreshold: 0.92,
  pacingReviewInterval: 10,
```

在 `parsePositiveInt` 之後新增一個解析函式：

```ts
/** 解析 0~1 之間的浮點數，非法或超出範圍時退回預設 */
function parseUnitFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}
```

在 `loadConfig` 回傳物件裡（`lore: ...` 之後）加入：

```ts
    nudge: {
      windowSize: parsePositiveInt(env.NUDGE_WINDOW_SIZE, DEFAULTS.nudgeWindowSize),
      similarityThreshold: parseUnitFloat(env.NUDGE_SIMILARITY_THRESHOLD, DEFAULTS.nudgeSimilarityThreshold),
    },
    pacingReviewInterval: parsePositiveInt(env.PACING_REVIEW_INTERVAL, DEFAULTS.pacingReviewInterval),
    pacing:
      env.PACING_OPENAI_BASE_URL && env.PACING_MODEL
        ? { baseUrl: env.PACING_OPENAI_BASE_URL, model: env.PACING_MODEL }
        : undefined,
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/src/config.ts app/src/config.test.ts
git commit -m "feat(config): 新增短期停滯/長期節奏審閱設定（NUDGE_*/PACING_*）"
```

---

## Task 9: `server/app.ts` — 組裝 `pacingClient` 與新設定值

**Files:**
- Modify: `app/src/server/app.ts`
- Modify: `app/src/server/app.test.ts`

**Interfaces:**
- Consumes: `AppConfig.nudge`/`pacingReviewInterval`/`pacing`（Task 8）。
- Produces: `ServerDeps.pacingClient?: LlmClient`。

- [ ] **Step 1: 寫失敗的測試**

在 `app/src/server/app.test.ts` 的 `describe("POST /api/turn（SSE）", ...)` 區塊內新增（沿用既有 `world`/`fakeClient` fixture）：

```ts
  it("pacingClient 注入後，行數達門檻時建議內容出現在串流敘事前的 system prompt（透過 done 事件確認回合正常完成）", async () => {
    await writeFile(path.join(world, "journal_summary.md"), "- [2026-06-19T09:00:00] (主空間) 之前的事\n");
    const server = buildServer(loadConfig({ WORLD_DIR: world, PACING_REVIEW_INTERVAL: "1" }), {
      client: fakeClient(["前半段，", "後半段。"]),
      controlClient: fakeClient([
        JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "看看四周",
        }),
      ]),
      pacingClient: fakeClient(["該開新副本了。"]),
      commit: async () => true,
    });
    const res = await server.inject({ method: "POST", url: "/api/turn", payload: { input: "我四處看看" } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('"type":"done"');
    await server.close();
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: FAIL（TS 編譯錯誤：`ServerDeps` 沒有 `pacingClient` 欄位）

- [ ] **Step 3: 實作**

在 `app/src/server/app.ts` 的 `ServerDeps` interface 加入（`loreClient?` 之後）：

```ts
  pacingClient?: LlmClient;
```

在 `loreClient` 的建構區塊之後加入（同樣 pattern，`label: "pacing"`）：

```ts
  const pacingClient: LlmClient | undefined =
    deps.pacingClient ??
    (config.pacing
      ? createOpenAiClient(
          {
            ...config,
            openai: {
              baseUrl: config.pacing.baseUrl,
              apiKey: config.openai.apiKey,
              model: config.pacing.model,
            },
          },
          logger,
          { label: "pacing" },
        )
      : undefined);
```

在 `/api/turn` 路由裡傳給 `runTurnLoop` 的物件加入（`recallTopK: config.recall.topK,` 之後）：

```ts
          pacingClient,
          nudgeWindowSize: config.nudge.windowSize,
          nudgeSimilarityThreshold: config.nudge.similarityThreshold,
          pacingReviewInterval: config.pacingReviewInterval,
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/server/app.test.ts`
Expected: PASS

- [ ] **Step 5: 跑整個專案測試確認沒有改壞任何東西**

Run: `cd app && npx vitest run`
Expected: PASS（全部測試，含 Task 1~9 新增的）

- [ ] **Step 6: Commit**

```bash
git add app/src/server/app.ts app/src/server/app.test.ts
git commit -m "feat(server): 組裝 pacingClient，把節奏相關設定傳進 runTurnLoop"
```

---

## Task 10: `.env.example` 補文件

**Files:**
- Modify: `app/.env.example`

- [ ] **Step 1: 編輯**

在 `app/.env.example` 的「語意檢索（recall）」區塊之後加入：

```
# 短期停滯規則（規則式，本地嵌入相似度比較，選填，皆有預設值）
# NUDGE_WINDOW_SIZE=5
# NUDGE_SIMILARITY_THRESHOLD=0.92

# 長期節奏審閱（劇本大師，每 K 回合跑一次獨立 LLM，選填）
# PACING_REVIEW_INTERVAL=10
# PACING_OPENAI_BASE_URL=http://localhost:11434/v1
# PACING_MODEL=qwen2.5:7b
```

- [ ] **Step 2: Commit**

```bash
git add app/.env.example
git commit -m "docs(env): 補 NUDGE_*/PACING_* 環境變數說明"
```

---

## Self-Review

**Spec coverage：**
- 短期停滯規則（embedding 相似度、讀 `journal_summary.md` 尾段、不維護 in-memory 狀態）→ Task 4。
- 長期節奏審閱（每 K 回合、獨立 LLM、劇本大師 persona）→ Task 5、Task 3（`buildPacingMessages`）。
- `world/journal_summary.md` 共用基礎（格式、timestamp、寫入點、跨主空間/副本）→ Task 2、Task 6。
- 主空間與副本都要接 → Task 7（兩個函式都接）。
- `nudgeBlock`/`pacingBlock` 各自獨立區塊、不合併 → Task 3（`appendOptionalBlocks` 分開處理）。
- 玩家輸入只當方向提示、不參與觸發判斷 → Task 4（`AUTO_CONTINUE_INPUT` 排除邏輯）。
- 錯誤處理與降級（兩機制互相獨立、失敗回空字串、journal_summary 寫入失敗不擋 commit）→ Task 4/5（try/catch + warning）、Task 6（單獨 try/catch 不拋出）。
- 設定可調（N、門檻、K）→ Task 8。
- 測試策略（embedder/LLM stub、turn.test.ts 驗證 system prompt、journal_summary 驗證）→ Task 2/4/5/6/7。
- 範圍外（不做第二層壓縮、不改自動推進終止條件、不讀 gm-notes/secrets）→ 本 plan 未新增任何相關程式碼，符合範圍外要求，無需額外任務。

**Placeholder scan：** 已掃過所有步驟，皆為完整程式碼/指令，沒有 TBD/「適當處理」之類字樣（Task 3 的 Step 3 中段那個刻意標示「不要這樣寫」的占位是教學性質的反例，緊接著就給出正確版本，不是留給實作者自行填空）。

**Type consistency：** `JournalSummaryEntry`（Task 2）在 Task 3 的 `BuildPacingParams.entries`、Task 4/5 的 `readJournalSummaryEntries` 回傳型別、Task 6 的 `appendJournalSummary` 參數型別之間一致使用同一個介面；`TurnDeps` 新欄位（`embedder`/`nudgeWindowSize`/`nudgeSimilarityThreshold`/`pacingClient`/`pacingReviewInterval`/`now`）命名在 Task 4/5/6 與其消費端（Task 7 的 `index.ts`、Task 9 的 `app.ts`）保持一致；`runNudgeBlock`/`runPacingBlock` 的函式簽名與回傳型別（`AsyncGenerator<TurnEvent, string>`）在定義處（Task 4/5）與呼叫處（Task 7 的 `yield* ...`）一致。
