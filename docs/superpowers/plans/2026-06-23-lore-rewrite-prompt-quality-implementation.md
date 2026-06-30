# Layer 3 Lore 重寫 Prompt 品質強化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 強化 `app/src/engine/turn/lore-rewrite.ts`、`lore-sync.ts` 的 Layer 3 prompt，讓重寫出的 wiki/secrets 文件統一用繁體中文書寫、依分類涵蓋玩家可見的基本說明、首次建檔時可合理擴寫風格細節而不卡死劇情，並修正 wiki 標題與隱藏設定措辭的既有 bug。

**Architecture:** 只動 prompt 文字與函式簽名（新增 `category` 參數），不動 `LoreEntityRefSchema`/`LoreContent`/`now.md` 七欄等既有資料結構。三個改動點全部落在 `app/src/engine/turn/lore-rewrite.ts`（`callLoreRewrite`、`generateItemSecrets`→`generateEntitySecrets`、`rewriteLoreEntity`）與 `app/src/engine/turn/lore-sync.ts`（`runLoreSync` 的 dungeon 呼叫點）。

**Tech Stack:** TypeScript, Vitest, Node.js（fs/promises 暫存目錄做整合測試）。

## Global Constraints

- 所有新增/修改的 system prompt 文字一律使用繁體中文書寫；避免簡體中文慣用詞彙（質量→品質、視頻→影片、軟件→軟體、信息→資訊、打印→列印）。— 來自 spec 第 1 節
- `callLoreRewrite`、`generateEntitySecrets` 不改變既有資料結構（`LoreEntityRefSchema`、`LoreContent`），只加函式參數。— 來自 spec「目標」
- 不引入 wikilink `[[ ]]` 語法或 recall 索引解析邏輯。— 來自 spec「非目標」
- 不改變「是否生成 secrets.md」的判斷邏輯，所有道具/場景/技能首次接觸都仍生成一次。— 來自 spec「非目標」

---

### Task 1: `callLoreRewrite` 依分類給大綱、語言規範、首次建檔擴寫邊界

**Files:**
- Modify: `app/src/engine/turn/lore-rewrite.ts:46-90`（`callLoreRewrite` 函式本體）、`lore-rewrite.ts:112-126`（`rewriteLoreEntity` 的 npc 分支呼叫點）、`lore-rewrite.ts:128-142`（`rewriteLoreEntity` 的 item/location/skill 分支呼叫點）
- Test: `app/src/engine/turn/lore-rewrite.test.ts`（新檔）

**Interfaces:**
- Consumes: 既有 `ChatMessage`/`LlmClient`（`app/src/llm/client.ts`）、`Logger`（`app/src/logger.ts`）
- Produces: 新的具名匯出 `LoreRewriteCategory = "npc" | "item" | "location" | "skill" | "dungeon"` 與 `LORE_REWRITE_CATEGORY_OUTLINE: Record<LoreRewriteCategory, string>`；`callLoreRewrite` 簽名變為 `callLoreRewrite(client, settingText, excerpt, docTitle, existingContent, category: LoreRewriteCategory, log)`（在 `log` 之前插入 `category`）。Task 2、Task 3 會呼叫這個新簽名。

- [ ] **Step 1: 在 `app/src/engine/turn/lore-rewrite.test.ts` 寫第一個失敗測試（語言規範 + 分類大綱）**

建立新檔 `app/src/engine/turn/lore-rewrite.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { logger } from "../../logger.js";
import { callLoreRewrite, type LoreRewriteCategory } from "./lore-rewrite.js";

function capturingClient(response: string): { client: LlmClient; messages: ChatMessage[] } {
  const result = { messages: [] as ChatMessage[] } as { client: LlmClient; messages: ChatMessage[] };
  result.client = {
    async *streamChat(messages: ChatMessage[]) {
      result.messages = messages;
      yield response;
    },
  };
  return result;
}

describe("callLoreRewrite", () => {
  it("system prompt 含繁體用詞規範", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", "item", logger);
    const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("避免使用中國大陸簡體中文慣用詞彙");
  });

  it.each([
    ["item", "外觀與基本辨識"],
    ["location", "已知規則或機關"],
    ["skill", "施展條件/限制"],
    ["npc", "與主角的關係"],
    ["dungeon", "已揭露地圖/環境"],
  ] as [LoreRewriteCategory, string][])(
    "category=%s 時 system prompt 含對應大綱關鍵字 %s",
    async (category, keyword) => {
      const cap = capturingClient("新版內容");
      await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", category, logger);
      const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain(keyword);
    },
  );
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/lore-rewrite.test.ts`
Expected: FAIL — `callLoreRewrite` 目前簽名沒有 `category` 參數，TypeScript/執行期會回報參數數量或型別不符（或 import 找不到 `LoreRewriteCategory`）。

- [ ] **Step 3: 修改 `callLoreRewrite`，加上 `category` 參數、分類大綱、語言規範、擴寫邊界規則**

把 `app/src/engine/turn/lore-rewrite.ts` 第 42-90 行（`callLoreRewrite` 函式，含其上方註解）整段換成：

```typescript
export type LoreRewriteCategory = "npc" | "item" | "location" | "skill" | "dungeon";

/** 各分類 wiki 常見可寫面向，純引導模型涵蓋玩家會想知道的基本說明，不是強制欄位 */
export const LORE_REWRITE_CATEGORY_OUTLINE: Record<LoreRewriteCategory, string> = {
  npc: "- 基本資訊（外觀/身份/性格）\n- 與主角的關係\n- 已知情報（自述/可驗證情報）\n- 備註/未解疑點",
  item:
    "- 外觀與基本辨識\n- 已知效果/用途（玩家視角已知的）\n- 取得或使用方式/限制\n- 目前已知的來歷或關聯人物事件（僅寫敘事中已揭露的部分）",
  location: "- 地理/環境描述\n- 已知規則或機關（已揭露部分）\n- 已知危險與資源\n- 出沒生物或 NPC",
  skill: "- 效果說明\n- 施展條件/限制\n- 已知代價或副作用\n- 取得方式",
  dungeon: "- 已揭露地圖/環境\n- 已知規則或機關\n- 已知危險與資源\n- 相關人物事件",
};

/**
 * 把【現有文件全文】+【本回合相關敘事片段】丟給 LLM，要求輸出完整新版內容（不是 diff、不是片段）。
 * 失敗或輸出空白時回 null，呼叫端視為「這筆略過」。
 */
export async function callLoreRewrite(
  client: LlmClient,
  settingText: string,
  excerpt: string,
  docTitle: string,
  existingContent: string,
  category: LoreRewriteCategory,
  log: Logger,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是本世界敘事引擎的知識庫維護者。任務：把【現有文件】依【本回合敘事片段】更新成一份完整、連貫的新版內容。",
        "",
        "語言與用詞：",
        "- 一律使用繁體中文書寫；避免使用中國大陸簡體中文慣用詞彙（例如「質量」→「品質」、「視頻」→「影片」、「軟件」→「軟體」、「信息」→「資訊」、「打印」→「列印」等），用詞符合台灣繁體中文書寫習慣。",
        "",
        "這份文件常見的可寫面向（不是每筆都要填滿；本回合片段沒提到、也沒有合理依據可擴寫的面向不要硬湊）：",
        LORE_REWRITE_CATEGORY_OUTLINE[category],
        "",
        "鐵則：",
        "- 只輸出文件完整新版內容本身（純文字/Markdown），不要 JSON、不要前言、不要程式碼框。",
        "- 若【現有文件全文】非空（更新既有文件）：不可遺漏現有文件中仍然成立的事實；只在片段明確提供新資訊或訂正時才改動對應部分；不可發明片段未提及的事實。",
        "- 若目前沒有現有文件（全新建檔）：可以在風格/氛圍類細節上做簡單合理的擴寫（例如視覺風格、材質、光線、氣味、外觀質感），讓內容有畫面感、之後好沿用；但不可發明會影響劇情走向的具體事實（真正用途、特殊機關、隱藏效果、與主線人物事件的關聯）——這些留給之後敘事片段揭露，或由暗線文件承接。本次擴寫過的風格細節，之後更新文件時要視為既定事實，不可無故更動。",
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
  } catch (err) {
    log.warn({ err }, "Layer 3 整檔重寫 LLM 呼叫失敗，略過該筆");
    return null;
  }
  const content = raw.trim();
  return content.length > 0 ? content : null;
}
```

- [ ] **Step 4: 更新 `rewriteLoreEntity` 的兩個呼叫點，補上 `category` 引數**

在 `app/src/engine/turn/lore-rewrite.ts` 的 `rewriteLoreEntity` 函式裡：

把 npc 分支（目前）：

```typescript
    const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, `NPC 角色檔案（${entity.name}）`, existing, log);
```

改成：

```typescript
    const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, `NPC 角色檔案（${entity.name}）`, existing, "npc", log);
```

把 item/location/skill 分支（目前）：

```typescript
  const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, title, existing.wiki, log);
```

改成：

```typescript
  const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, title, existing.wiki, entity.category, log);
```

- [ ] **Step 5: 執行測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/lore-rewrite.test.ts`
Expected: PASS（全部 6 個案例）

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/turn/lore-rewrite.ts app/src/engine/turn/lore-rewrite.test.ts
git commit -m "feat(engine): callLoreRewrite 依分類給大綱、補語言規範與首次建檔擴寫邊界"
```

---

### Task 2: `generateItemSecrets` → `generateEntitySecrets`（依分類套正確措辭）+ 修 wiki 標題用 id 的 bug

**Files:**
- Modify: `app/src/engine/turn/lore-rewrite.ts:14-28`（`generateItemSecrets` 函式）、`lore-rewrite.ts:128-142`（`rewriteLoreEntity` 的 item/location/skill 分支：呼叫點 + 標題行）
- Test: `app/src/engine/turn/lore-rewrite.test.ts`（沿用 Task 1 建立的檔案，新增測試）

**Interfaces:**
- Consumes: Task 1 產出的 `LoreRewriteCategory`（本任務只用其中 `"item" | "location" | "skill"` 子集）；既有 `ENTITY_CATEGORY_TITLE: Record<"item" | "location" | "skill", string>`（`lore-rewrite.ts:36-40`，不變)
- Produces: 新的具名匯出 `generateEntitySecrets(client, settingText, entityName, category: "item" | "location" | "skill"): Promise<string>`（取代 `generateItemSecrets`，呼叫端改用新名）；`rewriteLoreEntity` 回傳的 `title` 改用 `entity.name` 而非 `entity.id`。

- [ ] **Step 1: 在 `lore-rewrite.test.ts` 加上失敗測試（依分類措辭 + 標題用 name）**

在既有 `describe("callLoreRewrite", ...)` 區塊之後加：

```typescript
import { generateEntitySecrets, rewriteLoreEntity } from "./lore-rewrite.js";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { TurnDeps } from "./types.js";

describe("generateEntitySecrets", () => {
  it.each([
    ["item", "道具設計者", "道具名稱"],
    ["location", "場景設計者", "場景名稱"],
    ["skill", "技能設計者", "技能名稱"],
  ] as [("item" | "location" | "skill"), string, string][])(
    "category=%s 時措辭正確（%s / %s）",
    async (category, roleKeyword, nounKeyword) => {
      const cap = capturingClient("隱藏設定內容");
      await generateEntitySecrets(cap.client, "世界設定", "測試實體", category);
      const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
      const user = cap.messages.find((m) => m.role === "user")?.content ?? "";
      expect(system).toContain(roleKeyword);
      expect(user).toContain(nounKeyword);
    },
  );
});

describe("rewriteLoreEntity 標題", () => {
  it("道具 wiki 標題用 entity.name 而非 entity.id", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "items", "sword-001"), { recursive: true });

    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
        yield systemContent.includes("劇透文件") ? "隱藏設定內容" : "# 淬毒匕首\n\n外觀描述";
      },
    };
    const deps: TurnDeps = {
      client: fakeClient,
      worldDir,
      commit: async () => true,
    };

    const result = await rewriteLoreEntity(
      deps,
      "世界設定",
      { id: "sword-001", category: "item", name: "淬毒匕首", excerpt: "主角拿到一把淬毒匕首" },
      logger,
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("道具（淬毒匕首）");
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/lore-rewrite.test.ts`
Expected: FAIL — `generateEntitySecrets` 不存在（目前叫 `generateItemSecrets` 且無 `category` 參數）；標題測試會因 `generateEntitySecrets` import 失敗而整檔報錯。

- [ ] **Step 3: 把 `generateItemSecrets` 改寫成 `generateEntitySecrets`**

把 `app/src/engine/turn/lore-rewrite.ts` 第 13-28 行（`generateItemSecrets` 函式，含其上方註解）整段換成：

```typescript
/** 隱藏設定生成者，依分類套用對應的世界觀角色稱呼（道具/場景/技能設計者措辭不同） */
export const ENTITY_SECRETS_DESIGNER_ROLE: Record<"item" | "location" | "skill", string> = {
  item: "道具設計者",
  location: "場景設計者",
  skill: "技能設計者",
};

/** 為指定實體生成隱藏設定（劇透文件，僅供暗線一致，不可外洩）；依分類套用正確的角色稱呼與名詞，風格與 callLoreRewrite 對齊 */
export async function generateEntitySecrets(
  client: LlmClient,
  settingText: string,
  entityName: string,
  category: "item" | "location" | "skill",
): Promise<string> {
  const noun = ENTITY_CATEGORY_TITLE[category];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `你是本世界的${ENTITY_SECRETS_DESIGNER_ROLE[category]}。為指定${noun}生成隱藏設定（真實來歷、隱藏效果、與主線的關聯）。` +
        "這是劇透文件，玩家永遠不會直接看到，只供敘事暗線一致。只輸出設定內容本身，使用繁體中文書寫；避免使用中國大陸簡體中文慣用詞彙（例如「質量」→「品質」、「視頻」→「影片」、「軟件」→「軟體」、「信息」→「資訊」、「打印」→「列印」等），用詞符合台灣繁體中文書寫習慣。不要前言或客套。\n\n" +
        "世界設定：\n" + settingText.trim(),
    },
    { role: "user", content: `${noun}名稱：${entityName}。請生成其隱藏設定。` },
  ];
  let full = "";
  for await (const d of client.streamChat(messages)) full += d;
  return full.trim() || "（生成失敗，待補）";
}
```

注意：`ENTITY_CATEGORY_TITLE` 的宣告（第 36-40 行，`{ item: "道具", location: "場景", skill: "技能" }`）維持原位置不動，只是現在被 `generateEntitySecrets` 提前引用，所以這次改寫請保留它在原檔案中的位置（在 `generateEntitySecrets` 之後、`ENTITY_CATEGORY_TO_LORE` 旁邊即可，JS 的 `export const` 不需要在使用前面宣告，因為呼叫發生在函式內部執行時，而非模組載入時）。

- [ ] **Step 4: 更新 `rewriteLoreEntity` 的呼叫點與標題行**

把 `app/src/engine/turn/lore-rewrite.ts` 的 item/location/skill 分支裡（目前）：

```typescript
  const category = ENTITY_CATEGORY_TO_LORE[entity.category];
  const existing = await loadLore(deps.worldDir, category, entity.id, log);
  if (!existing.secrets) {
    const secretsText = await generateItemSecrets(deps.client, settingText, entity.name);
    await ensureSecrets(deps.worldDir, category, entity.id, secretsText, `隱藏設定（${entity.name}）`, log);
  }
  const title = `${ENTITY_CATEGORY_TITLE[entity.category]}（${entity.id}）`;
```

改成：

```typescript
  const category = ENTITY_CATEGORY_TO_LORE[entity.category];
  const existing = await loadLore(deps.worldDir, category, entity.id, log);
  if (!existing.secrets) {
    const secretsText = await generateEntitySecrets(deps.client, settingText, entity.name, entity.category);
    await ensureSecrets(deps.worldDir, category, entity.id, secretsText, `隱藏設定（${entity.name}）`, log);
  }
  const title = `${ENTITY_CATEGORY_TITLE[entity.category]}（${entity.name}）`;
```

（緊接著下一行 `const content = await callLoreRewrite(...)` 已在 Task 1 改過，這裡不需要再動。）

- [ ] **Step 5: 執行測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/lore-rewrite.test.ts`
Expected: PASS（全部案例，包含 Task 1 的測試仍綠燈）

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/turn/lore-rewrite.ts app/src/engine/turn/lore-rewrite.test.ts
git commit -m "fix(engine): 隱藏設定生成依分類套正確措辭、wiki 標題改用 entity.name"
```

---

### Task 3: `lore-sync.ts` 的副本 wiki 重寫點補上 `"dungeon"` category

**Files:**
- Modify: `app/src/engine/turn/lore-sync.ts:90-97`（`runLoreSync` 內處理 `dungeon_wiki_excerpt` 的區塊）
- Test: `app/src/engine/turn/lore-sync.test.ts`（沿用既有檔案，新增測試）

**Interfaces:**
- Consumes: Task 1 的 `callLoreRewrite(client, settingText, excerpt, docTitle, existingContent, category, log)` 新簽名
- Produces: 無新匯出；本任務是 Task 1 簽名變更的最後一個呼叫端更新，完成後全 repo 對 `callLoreRewrite` 的呼叫都已對齊新簽名。

- [ ] **Step 1: 在 `lore-sync.test.ts` 寫失敗測試（驗證 dungeon 呼叫帶正確 category）**

在 `app/src/engine/turn/lore-sync.test.ts` 加入：

```typescript
import { runLoreSync } from "./lore-sync.js";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { TurnDeps, TurnPlan } from "./types.js";

describe("runLoreSync 的副本 wiki 重寫", () => {
  it("呼叫 callLoreRewrite 時 system prompt 含 dungeon 分類大綱關鍵字", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "dungeons", "u-001"), { recursive: true });

    const capturedSystemPrompts: string[] = [];
    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        capturedSystemPrompts.push(system);
        if (system.includes("Layer 3")) {
          yield JSON.stringify({
            state_changes: {
              touched_entities: [],
              dungeon_wiki_excerpt: "主角發現了控制室的位置",
            },
          });
        } else {
          yield "# 副本 u-001 · 已揭露知識（Wiki）\n\n控制室位於地下二樓";
        }
      },
    };

    const deps: TurnDeps = {
      client: fakeClient,
      worldDir,
      commit: async () => true,
    };
    const plan: TurnPlan = {
      messages: [],
      buildFastControl: () => [],
      buildLoreSync: () => [{ role: "system", content: "Layer 3 prompt" }],
      appendRaw: async () => {},
      rawFilePath: path.join(worldDir, "dungeons", "u-001", "runs", "run-1.md"),
      dungeonId: "u-001",
    };

    await runLoreSync(deps, "敘事內容", "世界設定", plan, logger);

    const wikiPromptCalls = capturedSystemPrompts.filter((p) => p.includes("整檔重寫"));
    expect(wikiPromptCalls.some((p) => p.includes("已揭露地圖/環境"))).toBe(true);

    const wikiContent = await readFile(path.join(worldDir, "dungeons", "u-001", "wiki.md"), "utf8");
    expect(wikiContent).toContain("控制室");
  });
});
```

加上 `import { logger } from "../../logger.js";`（檔案開頭，與既有 `import type { Logger } ...` 並列）。

- [ ] **Step 2: 執行測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/lore-sync.test.ts`
Expected: FAIL — `callLoreRewrite` 在 `lore-sync.ts` 裡仍用舊簽名（缺 `category` 引數），TypeScript 編譯期/Vitest 型別檢查會報錯，或因引數位移導致 `log` 被當成 `category` 傳入而執行期出錯。

- [ ] **Step 3: 在 `runLoreSync` 補上 `"dungeon"` category**

把 `app/src/engine/turn/lore-sync.ts` 第 90-97 行（目前）：

```typescript
    let dungeonResult: LoreRewriteResult | null = null;
    if (changes.dungeon_wiki_excerpt && plan.dungeonId) {
      const rewriteClient = deps.loreClient ?? deps.controlClient ?? deps.client;
      const existing = await loadDungeonLore(deps.worldDir, plan.dungeonId, log);
      const title = `副本 ${plan.dungeonId} · 已揭露知識（Wiki）`;
      const content = await callLoreRewrite(rewriteClient, settingText, changes.dungeon_wiki_excerpt, title, existing.wiki, log);
      if (content) dungeonResult = { id: plan.dungeonId, category: "dungeon", title, content };
    }
```

改成：

```typescript
    let dungeonResult: LoreRewriteResult | null = null;
    if (changes.dungeon_wiki_excerpt && plan.dungeonId) {
      const rewriteClient = deps.loreClient ?? deps.controlClient ?? deps.client;
      const existing = await loadDungeonLore(deps.worldDir, plan.dungeonId, log);
      const title = `副本 ${plan.dungeonId} · 已揭露知識（Wiki）`;
      const content = await callLoreRewrite(
        rewriteClient,
        settingText,
        changes.dungeon_wiki_excerpt,
        title,
        existing.wiki,
        "dungeon",
        log,
      );
      if (content) dungeonResult = { id: plan.dungeonId, category: "dungeon", title, content };
    }
```

- [ ] **Step 4: 執行測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/lore-sync.test.ts`
Expected: PASS（既有的 `trackLoreSync` 測試與新測試都綠燈）

- [ ] **Step 5: 全專案測試 + 型別檢查**

Run: `cd app && npm run build && npx vitest run`
Expected: 編譯成功，全部測試 PASS（包含 `lore-rewrite.test.ts`、`lore-sync.test.ts` 與其餘既有測試）。若有其他檔案直接引用了 `generateItemSecrets`（已被改名），編譯會在此步驟報錯——逐一改成 `generateEntitySecrets` 並補上 `category` 引數後重跑本步驟。

- [ ] **Step 6: Commit**

```bash
git add app/src/engine/turn/lore-sync.ts app/src/engine/turn/lore-sync.test.ts
git commit -m "fix(engine): runLoreSync 副本 wiki 重寫補上 dungeon category"
```
