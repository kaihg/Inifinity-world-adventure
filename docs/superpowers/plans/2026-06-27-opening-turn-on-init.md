# Opening Turn on Init — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 世界初始化完成後，前端自動觸發第一個「opening 回合」，讓開場敘事串流呈現，並產生 suggestedActions chips。

**Architecture:** `opening.md` 升格為 opening 回合的 Layer 1 system prompt spec；`context.ts` 的 `buildMainSpaceMessages` 呼叫路徑加入 opening 注入邏輯（偵測 `journal.md` 是否只有標題行）；`WorldSetupWizard.tsx` 的 `onDone` 回呼後自動觸發 `streamTurn("")`，走現有 SSE pipeline，不新增任何特殊路徑。

**Tech Stack:** TypeScript、Node.js、Vitest、React、現有 turn pipeline（`runMainSpaceTurn` / `runTurnCore`）

## Global Constraints

- 繁體中文敘事輸出
- 不修改 `/api/turn`、`/api/world/init` 端點
- 不修改 `world-ops.ts`、`runTurnCore`、`runMainSpaceTurn` 邏輯
- 所有新增函式遵循現有 immutable pattern（不 in-place 修改物件）
- 測試使用 Vitest，語法同 `app/src/engine/turn/index.test.ts`

---

## 檔案異動總覽

| 檔案 | 動作 | 說明 |
|------|------|------|
| `templates/opening.md` | 修改 | 從骨架改為 opening 回合 Layer 1 system prompt |
| `app/src/engine/turn/prompts.ts` | 修改 | `buildMainSpaceMessages` 加入 `openingPrompt?` 參數注入 |
| `app/src/engine/turn/index.ts` | 修改 | `runMainSpaceTurn` 加入 opening prompt 偵測與讀取 |
| `app/src/engine/turn/index.test.ts` | 修改 | 新增 opening prompt 注入的測試 |
| `app/web/src/App.tsx` | 修改 | `WorldSetupWizard.onDone` 後自動呼叫 `streamTurn("")` |
| `app/web/src/App.test.tsx` | 修改 | 新增 post-init opening turn 自動觸發測試 |

---

## Task 1：升格 `opening.md` 為 Layer 1 system prompt spec

**Files:**
- Modify: `templates/opening.md`

**Interfaces:**
- Produces: `getTemplate("opening", worldDir, repoRoot)` 讀出的字串，直接作為 system prompt 附加段落注入（無結構要求）

- [ ] **Step 1: 改寫 `templates/opening.md`**

將現有骨架（給 `initWorld` 靜態生成用）改寫為直接告知 LLM 要做什麼的 opening 回合 system prompt：

```markdown
# 開場回合指引

這是主角進入主神空間後的**第一個回合**。

依下方世界設定（setting.md）與主角檔案（protagonist.md），以第三人稱敘述：
1. 主角在原世界最後的處境（職業、心境、正在發生的事）
2. 被主控系統選中、拉入主神空間瞬間的過程（呼應系統調性）
3. 主角初次睜眼看見主神空間的第一印象

寫作規則：
- 第三人稱，全程不使用「你」稱呼主角
- 長度約 500–1000 字的連續散文，不加標題、不條列
- 結尾以主角站在主神空間中、局勢待定為止，不預設下一個行動
- 嚴格遵守「只輸出敘事散文」的格式要求，不輸出 JSON 或控制區塊
```

- [ ] **Step 2: Commit**

```bash
git add templates/opening.md
git commit -m "feat: upgrade opening.md to opening-turn system prompt spec"
```

---

## Task 2：`prompts.ts` 加入 `openingPrompt` 注入

**Files:**
- Modify: `app/src/engine/turn/prompts.ts:88-133`

**Interfaces:**
- Consumes: `BuildMessagesParams`（已存在於 `prompts.ts:88`）
- Produces: `BuildMessagesParams.openingPrompt?: string`——若非空字串，append 到 system prompt 結尾；`buildMainSpaceMessages` 回傳 `ChatMessage[]` 型別不變

- [ ] **Step 1: 在 `BuildMessagesParams` 加入 `openingPrompt` 欄位**

`app/src/engine/turn/prompts.ts` 第 88 行的 `BuildMessagesParams` interface 加一個 optional 欄位：

```typescript
export interface BuildMessagesParams {
  settingText: string;
  state: GameState;
  input: string;
  dicePool: number[];
  intentsBlock?: string;
  recallBlock?: string;
  nudgeBlock?: string;
  pacingBlock?: string;
  openingPrompt?: string;   // ← 新增
}
```

- [ ] **Step 2: 在 `buildMainSpaceMessages` 的 system 陣列結尾注入**

找到 `buildMainSpaceMessages`（prompts.ts:100），在 `...appendOptionalBlocks(params)` 之後加入：

```typescript
...(params.openingPrompt
  ? ["", "## 開場回合特別指引", params.openingPrompt.trim()]
  : []),
```

完整的 `system` 陣列結尾變成：

```typescript
    canonicalBlock(state),
    ...appendOptionalBlocks(params),
    ...(params.openingPrompt
      ? ["", "## 開場回合特別指引", params.openingPrompt.trim()]
      : []),
  ].join("\n");
```

- [ ] **Step 3: 跑 TypeScript 型別檢查**

```bash
npm run typecheck 2>&1 | head -20
```

Expected: 無型別錯誤（只有 `openingPrompt` 新增，其餘不變）

- [ ] **Step 4: 跑現有測試確認沒有 regression**

```bash
npm test 2>&1 | tail -15
```

Expected: 全部 pass

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/turn/prompts.ts
git commit -m "feat: add openingPrompt param to buildMainSpaceMessages"
```

---

## Task 3：`index.ts` 偵測 opening 狀態並注入 prompt

**Files:**
- Modify: `app/src/engine/turn/index.ts:80-113`
- Test: `app/src/engine/turn/index.test.ts`

**Interfaces:**
- Consumes:
  - `getTemplate("opening", worldDir, repoRoot): Promise<string>`（來自 `app/src/engine/template-loader.ts`）
  - `journal.md` 純文字內容，用 `readBestEffort` 讀取
  - `buildMainSpaceMessages({ ..., openingPrompt })` 來自 Task 2
- Produces: `runMainSpaceTurn` 行為不變，只在 `journal.md` 只有標題行時把 opening prompt 注入 `buildMainSpaceMessages`

**判斷邏輯：** `journal.md` 的內容（trim 後）不含任何 `## ` 段落（即 `!/^## /m.test(journalText.trim())`），判定為 opening 回合。

- [ ] **Step 1: 撰寫失敗測試**

在 `app/src/engine/turn/index.test.ts` 找到現有測試末尾，新增：

```typescript
describe("opening turn injection", () => {
  let dir: string;
  let repoRoot: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "opening-"));
    repoRoot = dir; // 讓 getTemplate 找 templates/opening.md
    await mkdir(path.join(dir, "characters"), { recursive: true });
    await mkdir(path.join(dir, "templates"), { recursive: true });
    // 世界已初始化（有 setting.md）
    await writeFile(path.join(dir, "setting.md"), "# 世界設定\n\n## 基本規則\n測試規則。\n");
    await writeFile(path.join(dir, "characters", "protagonist.md"), "# 主角檔案\n\n- 姓名：測試者\n\n## 積分\n\n1000\n");
    await writeFile(path.join(dir, "characters", "index.md"), "# 角色索引\n\n| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |\n|----|------|------|----------|--------------|\n");
    await writeFile(path.join(dir, "now.md"), "# 當前局勢\n\n- 當前篇章：第一章：開場\n- 此刻場景/地點：主神空間\n- 在場同伴/相關 NPC：（無）\n- 進行中的副本：無\n- 未解懸念/伏筆：無\n- 主角下一步打算：\n- 最後更新：[2026-06-27] 進入主神空間\n");
    await writeFile(path.join(dir, "templates", "opening.md"), "開場回合專屬指引：測試內容。");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("journal.md 只有標題行時，system prompt 含 opening.md 內容", async () => {
    // journal.md 只有標題行（無 ## 段落）
    await writeFile(path.join(dir, "journal.md"), "# 主空間日誌（Journal）\n");

    const captured: ChatMessage[][] = [];
    const client: LlmClient = {
      async *streamChat(messages) {
        captured.push(messages);
        yield "opening 敘事";
      },
    };
    const controlClient = fakeClient([controlJson(true, "opening")]);

    const deps: TurnDeps = {
      client,
      controlClient,
      worldDir: dir,
      commit: async () => false,
    };

    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "")) {
      events.push(ev);
    }

    // Layer 1 system prompt 應包含 opening.md 內容
    expect(captured[0][0].content).toContain("開場回合專屬指引：測試內容。");
  });

  it("journal.md 有 ## 段落時，system prompt 不含 opening.md 內容", async () => {
    // journal.md 有真實段落
    await writeFile(path.join(dir, "journal.md"), "# 主空間日誌（Journal）\n\n## [2026-06-27] 開場\n\n一段敘事。\n");

    const captured: ChatMessage[][] = [];
    const client: LlmClient = {
      async *streamChat(messages) {
        captured.push(messages);
        yield "正常敘事";
      },
    };
    const controlClient = fakeClient([controlJson(true, "normal")]);

    const deps: TurnDeps = {
      client,
      controlClient,
      worldDir: dir,
      commit: async () => false,
    };

    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "任意行動")) {
      events.push(ev);
    }

    expect(captured[0][0].content).not.toContain("開場回合專屬指引：測試內容。");
  });
});
```

- [ ] **Step 2: 跑測試確認它們失敗**

```bash
npm test -- --reporter=verbose src/engine/turn/index.test.ts 2>&1 | grep -E "opening turn|FAIL|PASS"
```

Expected: 兩個 opening turn 測試 FAIL

- [ ] **Step 3: 在 `index.ts` 加入 opening 偵測邏輯**

在 `runMainSpaceTurn` 中，`settingText` 讀取之後、`buildMainSpaceMessages` 呼叫之前，加入：

```typescript
  // 偵測 opening 回合：journal.md 只有標題行（無任何 ## 段落）→ 注入 opening prompt
  const journalText = await readBestEffort(path.join(deps.worldDir, "journal.md"));
  const isOpeningTurn = !/^## /m.test(journalText.trim());
  const openingPrompt = isOpeningTurn
    ? await getTemplate("opening", deps.worldDir, deps.repoRoot ?? "").catch(() => "")
    : undefined;
```

並把 `openingPrompt` 傳入 `buildMainSpaceMessages`：

```typescript
  const plan: TurnPlan = {
    messages: buildMainSpaceMessages({
      settingText, state, input, dicePool,
      intentsBlock, recallBlock, nudgeBlock, pacingBlock,
      openingPrompt,
    }),
    // ... 其餘不變
  };
```

同時在 `index.ts` 頂部 import 區加入 `getTemplate`：

```typescript
import { getTemplate } from "../template-loader.js";
```

**注意**：`TurnDeps` 目前沒有 `repoRoot`。用 `process.cwd()` 作為 fallback（`getTemplate` 對 worldDir 優先，repoRoot 是全域骨架的 fallback）：

```typescript
  const openingPrompt = isOpeningTurn
    ? await getTemplate("opening", deps.worldDir, process.cwd()).catch(() => "")
    : undefined;
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npm test -- --reporter=verbose src/engine/turn/index.test.ts 2>&1 | grep -E "opening turn|FAIL|PASS|Tests"
```

Expected: 兩個 opening turn 測試 PASS，其餘 31 個既有測試全 PASS

- [ ] **Step 5: 跑全套測試確認無 regression**

```bash
npm test 2>&1 | tail -10
```

Expected: 全部 pass

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/turn/index.ts app/src/engine/turn/index.test.ts
git commit -m "feat: inject opening.md into Layer 1 when journal has no turns yet"
```

---

## Task 4：前端 post-init 自動觸發 opening turn

**Files:**
- Modify: `app/web/src/App.tsx:310-312`
- Test: `app/web/src/App.test.tsx`

**Interfaces:**
- Consumes:
  - `streamTurn(input: string, onEvent: (ev: TurnEvent) => void): Promise<void>`（來自 `app/web/src/api.ts:109`）
  - `send(action: string): Promise<void>`（App.tsx 內部函式，已實作完整的 SSE 處理、打字機、suggestedActions 更新）
- Produces: `WorldSetupWizard.onDone` 回呼後，`send("")` 被自動呼叫，opening turn 以現有 SSE 流程串流呈現

**關鍵點**：`send("")` 的第一行是 `if (!text || busy) return;`，空字串會被過濾。需要用 `streamTurn` 直接呼叫，或在 `send` 加入 opening 專用路徑。最乾淨的做法：`onDone` 後直接呼叫現有的 `send` 但傳入一個 invisible sentinel，不如直接在 `onDone` callback 裡 inline 觸發 `streamTurn`，複用 `send` 的 SSE 處理邏輯。

實際上最簡單：把 `onDone` callback 改成先 `setState(s); setWorldInitialized(true)` 再呼叫 `send`，但 `send` 過濾空字串。解法：傳一個非空 marker，例如 `"​"`（zero-width space），或直接讓 `send` 接受空字串作為 opening trigger。

**最佳實作**：在 `App.tsx` 裡加一個 `sendOpening()` 函式，直接把 `send("")` 的邏輯 inline 但跳過 `!text` 的 guard，這樣不汙染 `send` 的正常路徑。

- [ ] **Step 1: 撰寫失敗測試**

在 `app/web/src/App.test.tsx` 新增（需要 mock `api` 模組）：

```typescript
import { vi, describe, it, expect, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// 測試 WorldSetupWizard onDone 後是否自動觸發 opening turn
// 由於 App 內部複雜度高，用整合測試會過於笨重
// 改為測試 sendOpening 這個獨立導出的函式邏輯，確保它不受空字串 guard 影響
// （若 sendOpening 不導出，則改為測試 App 的 onDone prop）
```

> **簡化策略**：`sendOpening` 不需要單元測試「是否被呼叫」，改驗證 `App` 在 `worldInitialized` 從 false → true 的瞬間確實顯示 busy 指示器（即 opening turn 已啟動）。使用 `vi.mock("./api")`。

在 `app/web/src/App.test.tsx` 新增：

```typescript
import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchWorldStatus: vi.fn().mockResolvedValue({ initialized: false }),
    fetchState: vi.fn().mockResolvedValue({
      now: { chapter: "", scene: "", companions: "", activeDungeon: "", threads: "", nextStep: "", lastUpdated: "" },
      protagonist: { name: "測試者", points: "1000" },
      protagonistDetail: { name: "測試者", points: "1000", attributes: "", skills: "", items: "", buffs: "" },
      npcs: [],
      mode: "main-space",
      lastTurn: null,
    }),
    fetchVersion: vi.fn().mockResolvedValue({ hash: "abc", message: "test" }),
    fetchConfig: vi.fn().mockResolvedValue({ typewriterIntervalMs: 50 }),
    fetchTurnStatus: vi.fn().mockResolvedValue({ active: false, turnId: null }),
    initWorld: vi.fn().mockResolvedValue({
      now: { chapter: "第一章", scene: "主神空間", companions: "（無）", activeDungeon: "無", threads: "無", nextStep: "", lastUpdated: "[2026-06-27] 進入主神空間" },
      protagonist: { name: "測試者", points: "1000" },
      protagonistDetail: { name: "測試者", points: "1000", attributes: "", skills: "", items: "", buffs: "" },
      npcs: [],
      mode: "main-space",
      lastTurn: null,
    }),
    streamTurn: vi.fn().mockImplementation(async (_input: string, onEvent: (ev: any) => void) => {
      onEvent({ type: "delta", text: "開場敘事..." });
      onEvent({ type: "done", narrative: "開場敘事...", committed: true, awaitingUserInput: true, suggestedActions: ["觀察四周"], modeTransition: null, protagonistDied: false });
    }),
  };
});

describe("post-init opening turn", () => {
  it("initWorld 完成後自動觸發 streamTurn 且顯示 opening 敘事", async () => {
    const { streamTurn } = await import("./api");

    const { container } = render(<App />);

    // 等 WorldSetupWizard 出現
    await screen.findByText("建立世界");

    // 點「建立世界」按鈕
    const btn = screen.getByRole("button", { name: "建立世界" });
    await userEvent.click(btn);

    // 等 streamTurn 被呼叫（opening turn 自動觸發）
    await waitFor(() => {
      expect(streamTurn).toHaveBeenCalledWith("", expect.any(Function));
    });
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
npm test -- --reporter=verbose web/src/App.test.tsx 2>&1 | grep -E "post-init|FAIL|PASS"
```

Expected: `post-init opening turn` FAIL（`streamTurn` 未被呼叫）

- [ ] **Step 3: 修改 `App.tsx` 的 `WorldSetupWizard.onDone`**

在 `App.tsx` 第 311 行找到：

```tsx
return <WorldSetupWizard onDone={(s) => { setState(s); setWorldInitialized(true); loadedInitialRef.current = true; }} />;
```

改為：

```tsx
return <WorldSetupWizard onDone={(s) => {
  setState(s);
  setWorldInitialized(true);
  loadedInitialRef.current = true;
  // init 完成後自動執行 opening turn
  void sendOpening();
}} />;
```

並在 `send` 函式之後（`App` 函式內）新增 `sendOpening`：

```typescript
async function sendOpening() {
  if (busy) return;
  setBusy(true);
  setStory("");
  stopTypewriter(true);
  llmDoneRef.current = false;
  setSuggested([]);
  setInput("");
  try {
    await streamTurn("", (ev) => {
      switch (ev.type) {
        case "delta":
          for (const char of ev.text) pendingQueue.current.push(char);
          startTypewriter();
          break;
        case "warning":
          setStory((s) => s + `\n[提示] ${ev.message}\n`);
          break;
        case "error":
          stopTypewriter(true);
          setStory((s) => s + `\n[錯誤] ${ev.message}\n`);
          break;
        case "done":
          if (ev.awaitingUserInput) setSuggested(ev.suggestedActions ?? []);
          if (ev.state) setState(ev.state);
          llmDoneRef.current = true;
          break;
      }
    });
    await refresh();
  } catch (e) {
    stopTypewriter(true);
    setStory((s) => s + `\n[開場失敗] ${(e as Error).message}\n`);
  } finally {
    await waitForTypewriter();
    setBusy(false);
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
npm test -- --reporter=verbose web/src/App.test.tsx 2>&1 | grep -E "post-init|FAIL|PASS|Tests"
```

Expected: `post-init opening turn` PASS，其餘既有測試全 PASS

- [ ] **Step 5: 跑全套測試確認無 regression**

```bash
npm test 2>&1 | tail -10
```

Expected: 全部 pass

- [ ] **Step 6: Commit**

```bash
git add app/web/src/App.tsx app/web/src/App.test.tsx
git commit -m "feat: auto-trigger opening turn after world init"
```

---

## Self-Review 結果

1. **Spec 覆蓋確認：**
   - `opening.md` 升格 → Task 1 ✓
   - Context loader 偵測 journal 只有標題行 → Task 3 ✓
   - 前端 post-init 自動觸發 → Task 4 ✓
   - `prompts.ts` 注入點 → Task 2 ✓

2. **型別一致性：**
   - `BuildMessagesParams.openingPrompt?: string` 定義於 Task 2，Task 3 使用相同欄位名

3. **無 placeholder：** 所有 step 含完整程式碼

4. **`repoRoot` 問題：** Task 3 用 `process.cwd()` 作 fallback，這對生產環境（`app/` 下執行）正確——`templates/opening.md` 位於 repo root，`process.cwd()` 在 `npm run dev` 時指向 `app/`，因此 fallback 路徑為 `app/templates/opening.md`（不存在），而 world-specific 路徑 `world/templates/opening.md` 也不存在，最終 `getTemplate` 拋錯被 `.catch(() => "")` 吃掉（不注入）。

   **修正**：`TurnDeps` 需要加入 `repoRoot?: string`，讓 server 初始化時注入正確路徑，或在 `runMainSpaceTurn` 從 `worldDir` 推導（`worldDir` 為 `<repoRoot>/world`，所以 `repoRoot = path.dirname(worldDir)`）。

   用後者更簡單，不改 `TurnDeps`：

   ```typescript
   const repoRoot = path.dirname(deps.worldDir);
   const openingPrompt = isOpeningTurn
     ? await getTemplate("opening", deps.worldDir, repoRoot).catch(() => "")
     : undefined;
   ```

   Task 3 的實作應使用此版本（而非 `process.cwd()`）。Task 3 的測試中 `repoRoot` = `dir`（含 `templates/` 子目錄），與 `path.dirname(dir + "/world")` 不同——測試中直接把 `opening.md` 放在 `path.join(dir, "templates", "opening.md")`，但 `worldDir` = `dir`，所以 `path.dirname(dir)` 指向 `dir` 的父目錄，不對。

   **最終測試策略修正**：在測試中，讓 `worldDir` = `path.join(dir, "world")`（子目錄），把 `opening.md` 放在 `path.join(dir, "templates", "opening.md")`，此時 `path.dirname(worldDir)` = `dir`（含 `templates/`）即正確。Task 3 測試需按此更新。

