# Layer 權責重劃 + protagonist 全檔重寫 + Bug 2/4/5 prompt 收緊 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「世界狀態更新」（積分、主角成長、實體 lore）從 Layer 2 移到 Layer 3，protagonist 改為全檔重寫以根治重複落地，並收緊三條 prompt（id 直譯、禁止照搬敘事散文）。

**Architecture:** Layer 2（fast-control）瘦身成「玩家這回合即時可見」的最小欄位（now / rolls / awaiting / suggested / commit / mode_transition / transition_* / protagonist_permanent_death）。Layer 3（reactive-lore-sync）接手 `protagonist_points_delta` + 新增 `protagonist_changed` 布林，觸發時先以引擎決定論 `applyPointsDelta` 落地積分，再呼叫新函式 `callProtagonistRewrite` 整檔重寫 protagonist.md。積分/主角更新因此延遲一回合反映面板（與既有 NPC 一致），零前端改動。

**Tech Stack:** TypeScript（ESM, NodeNext）、Zod schema、Vitest、既有三層 LLM pipeline。

## Global Constraints

- 只動 `app/` 引擎與測試，**不修現有 `world/` 壞檔**（CLAUDE.md 劇情/開發分離）。
- 不可變更新：回傳新物件，不 mutate 既有物件（`~/.claude/rules`）。
- 公開函式標註參數與回傳型別；避免 `any`。
- TDD：每個 Task 先寫失敗測試 → 跑紅 → 最小實作 → 跑綠 → commit。
- `protagonist_permanent_death`（Layer 2 既有欄位，死亡轉場用）**保留在 Layer 2，不可移除、不可動**。
- 繁體中文落地：所有經模型產生、會寫進 `world/` 的中文字串，落地前已由既有 `toTraditional` / `traditionalizeFastControl` 兜底；本計畫沿用，不重造。
- 測試指令一律在 `app/` 目錄下執行：`cd app && npx vitest run <file>`。
- commit 前不附帶 `world/` 變更（`git add` 只加 `app/` 路徑）。

---

## File Structure

| 檔案 | 責任 | 動作 |
|---|---|---|
| `app/src/engine/schema.ts` | Zod schema：FastControl 移除 protagonist 欄位；LoreSync 新增 `protagonist_points_delta` + `protagonist_changed` | Modify |
| `app/src/engine/turn/lore-rewrite.ts` | 新增 `callProtagonistRewrite`；收緊 `callLoreRewrite` 鐵則（禁照搬敘事） | Modify |
| `app/src/engine/turn/lore-sync.ts` | Layer 3 編排：注入 protagonist 落地（applyPointsDelta → callProtagonistRewrite → 覆寫） | Modify |
| `app/src/engine/turn/turn-core.ts` | 移除 Layer 2 的 protagonist 積分/updates 落地段 | Modify |
| `app/src/engine/turn/prompts.ts` | FAST_CONTROL_FORMAT_BLOCK 移除 protagonist 欄位說明；LORE_SYNC_FORMAT_BLOCK 新增 protagonist 欄位 + id 直譯規則 | Modify |
| `app/src/engine/context.ts` | 刪除 `applyProtagonistUpdates` / `appendToSection` / `normalizeItem`（dead code）；保留 `applyPointsDelta` | Modify |
| `app/src/engine/turn/types.ts` | 確認 TurnDeps 已有 `today`（積分落地需日期）——只讀確認，無改動 | Verify |

**Task 順序理由**：先改 schema（型別契約，下游全依賴它）→ 新增 `callProtagonistRewrite`（Layer 3 要用）→ 改 lore-sync 編排（接上重寫）→ 移除 turn-core 舊落地（避免雙寫）→ prompts 收緊 → 清 dead code（最後做，確認無引用）。

---

## Task 1: schema 權責重劃

**Files:**
- Modify: `app/src/engine/schema.ts:38-82`
- Test: `app/src/engine/schema.test.ts`

**Interfaces:**
- Consumes: 既有 `FastControlSchema`、`LoreSyncSchema`、`parseFastControlOutput`、`parseLoreSyncOutput`。
- Produces:
  - `FastControl.state_changes` 不再有 `protagonist_points_delta` / `protagonist_updates`（保留 `now`）。
  - `LoreSync.state_changes` 新增 `protagonist_points_delta?: number`、`protagonist_changed: boolean`（預設 false）。
  - 型別 `LoreSync` 供 lore-sync.ts 取用。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/engine/schema.test.ts` 末尾新增：

```typescript
describe("Layer 權責重劃：protagonist 欄位移到 Layer 3", () => {
  it("FastControl 解析時忽略殘留的 protagonist_points_delta（不再是 schema 欄位）", () => {
    const control = parseFastControlOutput(
      JSON.stringify({
        state_changes: { now: { scene: "資訊室" }, protagonist_points_delta: 5 },
        awaiting_user_input: true,
        commit_summary: "x",
      }),
    );
    // 欄位已從 FastStateChangesSchema 移除：解析不應再暴露它
    expect((control.state_changes as Record<string, unknown>).protagonist_points_delta).toBeUndefined();
    expect((control.state_changes as Record<string, unknown>).protagonist_updates).toBeUndefined();
    expect(control.state_changes.now?.scene).toBe("資訊室");
  });

  it("LoreSync 解析 protagonist_points_delta 與 protagonist_changed", () => {
    const sync = parseLoreSyncOutput(
      JSON.stringify({
        state_changes: { protagonist_points_delta: 3, protagonist_changed: true },
      }),
    );
    expect(sync.state_changes.protagonist_points_delta).toBe(3);
    expect(sync.state_changes.protagonist_changed).toBe(true);
  });

  it("LoreSync 的 protagonist_changed 缺省時為 false", () => {
    const sync = parseLoreSyncOutput(JSON.stringify({ state_changes: {} }));
    expect(sync.state_changes.protagonist_changed).toBe(false);
    expect(sync.state_changes.protagonist_points_delta).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/schema.test.ts`
Expected: FAIL — 新增的三個測試紅（protagonist_changed 不存在、Layer 2 仍暴露舊欄位）。

- [ ] **Step 3: 改 schema**

在 `app/src/engine/schema.ts`，`FastStateChangesSchema` 移除兩個 protagonist 欄位（保留 `now`）：

```typescript
/** Layer 2（fast-control）：done event 與 now/commit 所需的最小欄位子集 */
const FastStateChangesSchema = z
  .object({
    now: NowChangesSchema.optional(),
  })
  .default({});
```

`LoreStateChangesSchema` 新增兩欄：

```typescript
const LoreStateChangesSchema = z
  .object({
    touched_entities: z.array(LoreEntityRefSchema).optional(),
    dungeon_wiki_excerpt: z.string().optional(),
    protagonist_points_delta: z.number().optional(),
    protagonist_changed: z.boolean().default(false),
  })
  .default({});
```

`ProtagonistUpdatesSchema`（schema.ts 既有，原供 Layer 2 用）若無其他引用則一併刪除——先確認：`cd app && grep -rn "ProtagonistUpdatesSchema" src`。只在 schema.ts 內被 `FastStateChangesSchema` 用到的話，刪除其定義。

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/schema.test.ts`
Expected: PASS（含既有測試；若既有 VALID fixture 帶 `protagonist_points_delta` 仍可解析，因 zod 預設忽略未知鍵）。

- [ ] **Step 5: typecheck（會曝出下游引用錯誤，預期）**

Run: `cd app && npm run typecheck`
Expected: FAIL — turn-core.ts 仍引用 `control.state_changes.protagonist_points_delta` 等，於 Task 4 修復。**此處先記錄錯誤訊息，不修。**

- [ ] **Step 6: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/schema.ts app/src/engine/schema.test.ts
git commit -m "refactor(schema): protagonist 欄位從 Layer 2 移到 Layer 3（points_delta + changed）"
```

---

## Task 2: 新增 callProtagonistRewrite + 收緊 callLoreRewrite 鐵則

**Files:**
- Modify: `app/src/engine/turn/lore-rewrite.ts:93-129`（callLoreRewrite 鐵則）、新增 `callProtagonistRewrite`
- Test: `app/src/engine/turn/lore-rewrite.test.ts`

**Interfaces:**
- Consumes: `LlmClient`、`Logger`、`LoreRewriteContext`、`TRADITIONAL_CHINESE_RULE`、既有 `toTraditional`（lore-rewrite 末段已用於繁體化回傳）。
- Produces:
  - `export async function callProtagonistRewrite(client: LlmClient, settingText: string, excerpt: string, existingContent: string, log: Logger, context?: LoreRewriteContext): Promise<string | null>` — 回傳整份新版 protagonist.md（已繁體化），失敗/空白回 null。
  - `callLoreRewrite` 鐵則新增「禁止照搬敘事散文/系統提示」一條（共用於 entity/dungeon/protagonist）。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/engine/turn/lore-rewrite.test.ts` 末尾新增（沿用該檔既有 fake client 風格——以 system prompt 內容判斷回傳）：

```typescript
import { callProtagonistRewrite } from "./lore-rewrite.js";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { logger } from "../../logger.js";

describe("callProtagonistRewrite", () => {
  function fakeClient(captured: { system: string[]; user: string[] }, out: string): LlmClient {
    return {
      async *streamChat(messages: ChatMessage[]) {
        captured.system.push(messages.find((m) => m.role === "system")?.content ?? "");
        captured.user.push(messages.find((m) => m.role === "user")?.content ?? "");
        yield out;
      },
    };
  }

  it("把現有 protagonist 全文 + 敘事片段送進去，回傳整檔新版（繁體化）", async () => {
    const captured = { system: [] as string[], user: [] as string[] };
    const existing = "# 主角檔案\n- 姓名：沈奕\n- 當前積分：3\n\n## 物品欄\n- 戰術刀\n";
    const out = await callProtagonistRewrite(
      fakeClient(captured, "# 主角檔案\n- 姓名：沈奕\n- 當前積分：3\n\n## 物品欄\n- 戰術刀\n- 生鏽鐵管\n"),
      "世界設定",
      "沈奕從地上撿起一根生鏽鐵管。",
      existing,
      logger,
    );
    expect(out).toContain("生鏽鐵管");
    expect(captured.user[0]).toContain("沈奕從地上撿起一根生鏽鐵管"); // 敘事片段有送進去
    expect(captured.user[0]).toContain("當前積分：3"); // 現有全文有送進去
  });

  it("system prompt 含「積分區塊照抄不可改動」與「禁止照搬敘事散文」鐵則", async () => {
    const captured = { system: [] as string[], user: [] as string[] };
    await callProtagonistRewrite(fakeClient(captured, "x"), "設定", "片段", "# 主角\n- 當前積分：0\n", logger);
    expect(captured.system[0]).toContain("積分");
    expect(captured.system[0]).toContain("照抄");
    expect(captured.system[0]).toContain("禁止");
  });

  it("簡體輸出會被繁體化（決定論兜底）", async () => {
    const captured = { system: [] as string[], user: [] as string[] };
    const out = await callProtagonistRewrite(fakeClient(captured, "# 主角\n- 获得资讯\n"), "設定", "片段", "# 主角\n", logger);
    expect(out).toContain("資訊");
    expect(out).not.toContain("资讯");
  });

  it("LLM 回空白時回 null", async () => {
    const captured = { system: [] as string[], user: [] as string[] };
    const out = await callProtagonistRewrite(fakeClient(captured, "   "), "設定", "片段", "# 主角\n", logger);
    expect(out).toBeNull();
  });
});

describe("callLoreRewrite 禁止照搬敘事散文", () => {
  it("system prompt 含「禁止照搬敘事/系統提示」鐵則", async () => {
    const captured: string[] = [];
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        captured.push(messages.find((m) => m.role === "system")?.content ?? "");
        yield "# 道具（鐵管）\n";
      },
    };
    await callLoreRewrite(client, "設定", "片段", "道具（鐵管）", "", "item", logger);
    expect(captured[0]).toContain("禁止");
    expect(captured[0]).toMatch(/照搬|轉貼|系統提示/);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/lore-rewrite.test.ts`
Expected: FAIL — `callProtagonistRewrite` 未定義；callLoreRewrite 鐵則尚無「禁止照搬」字樣。

- [ ] **Step 3: 收緊 callLoreRewrite 鐵則**

在 `app/src/engine/turn/lore-rewrite.ts` 的 `callLoreRewrite` system content 「鐵則：」陣列中，於既有「全新建檔」那條之後，新增一條（保持與既有條目同格式）：

```typescript
        "- 輸出是**整理過的知識條目**，不是敘事轉貼。禁止把本回合敘事片段的散文、對白、系統提示（如【系統公告】【副本載入完畢】【系統提示】）原文照抄進文件；只能把片段中的事實**提煉**成條列式設定描述。文件中不應出現「本回合」「沈奕這時」這類敘事時序語句。",
```

- [ ] **Step 4: 新增 callProtagonistRewrite**

在 `app/src/engine/turn/lore-rewrite.ts`，`callLoreRewrite` 之後新增（共用 `formatContextLine`、`TRADITIONAL_CHINESE_RULE`、`toTraditional`，與 callLoreRewrite 同款 try/catch + 繁體化收尾）：

```typescript
/**
 * 主角檔案（protagonist.md）整檔重寫：把【現有全文（積分已由引擎決定論落地）】+【本回合敘事片段】
 * 丟給 LLM，要求輸出完整新版內容。對標 callLoreRewrite，但積分區塊必須照抄不可改動
 * （引擎已算好寫進現有全文），模型只負責整合屬性/技能/物品/buff 的成長，天然去重。
 * 失敗或空白回 null（呼叫端保留現有全文不覆寫）。
 */
export async function callProtagonistRewrite(
  client: LlmClient,
  settingText: string,
  excerpt: string,
  existingContent: string,
  log: Logger,
  context?: LoreRewriteContext,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是本世界敘事引擎的主角檔案維護者。任務：把【現有主角檔案全文】依【本回合敘事片段】更新成一份完整、連貫的新版內容。",
        "",
        "語言與用詞：",
        `- ${TRADITIONAL_CHINESE_RULE}`,
        "",
        "鐵則：",
        "- 只輸出主角檔案完整新版內容本身（純文字/Markdown），不要 JSON、不要前言、不要程式碼框。",
        "- **「當前積分」數值與其所在區塊一律照抄現有全文，絕不可改動**（積分由引擎另行計算，你動了就是錯）。",
        "- 不可遺漏現有全文中仍然成立的事實；只在敘事片段明確提供新的屬性/技能/物品/buff 變化時，才把該變化整合進對應區塊。",
        "- 整合時若某項已存在（即使措辭不同），更新該項而非新增重複條目；不可發明敘事未提及的成長。",
        "- 輸出是整理過的角色檔案，不是敘事轉貼。禁止把敘事片段的散文、對白、系統提示原文照抄進檔；文件中不應出現「本回合」這類敘事時序語句。",
        "",
        "世界設定：",
        settingText.trim(),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        ...(context ? [formatContextLine(context), ""] : []),
        `現有主角檔案全文：\n${existingContent.trim()}`,
        "",
        `本回合敘事片段：\n${excerpt.trim()}`,
      ].join("\n"),
    },
  ];
  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
  } catch (err) {
    log.warn({ err }, "主角檔案整檔重寫 LLM 呼叫失敗，保留現有檔案");
    return null;
  }
  const content = toTraditional(raw.trim());
  return content.length > 0 ? content : null;
}
```

> 注意：確認 `toTraditional` 已在 lore-rewrite.ts 匯入（callLoreRewrite 末段已用）。若未匯入，於檔頂 `import { toTraditional } from "../text/traditionalize.js";`。先 `cd app && grep -n "toTraditional" src/engine/turn/lore-rewrite.ts` 確認。

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/lore-rewrite.test.ts`
Expected: PASS（新測試全綠；既有測試不受影響）。

- [ ] **Step 6: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/turn/lore-rewrite.ts app/src/engine/turn/lore-rewrite.test.ts
git commit -m "feat(lore-rewrite): 新增 callProtagonistRewrite，收緊禁照搬敘事鐵則"
```

---

## Task 3: Layer 3 編排接上 protagonist 落地

**Files:**
- Modify: `app/src/engine/turn/lore-sync.ts:74-178`
- Test: `app/src/engine/turn/lore-sync.test.ts`

**Interfaces:**
- Consumes: `callProtagonistRewrite`（Task 2）、`applyPointsDelta`（context.ts 既有）、`sync.state_changes.protagonist_points_delta` / `protagonist_changed`（Task 1）、`deps.today`（TurnDeps 既有，回合日期）、`loreContext`（lore-sync 既有）。
- Produces: `runLoreSync` 在 entity 重寫之後、commit 之前，落地 protagonist；`results.length > 0` 的 commit 條件擴充為「有 lore 異動 **或** 有 protagonist 異動」。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/engine/turn/lore-sync.test.ts` 末尾新增（沿用該檔 mkdtemp + fakeClient 風格；Layer 3 prompt 以 "Layer 3" 判斷，protagonist 重寫以 system 含「主角檔案維護者」判斷）：

```typescript
import { writeFile, mkdir as mkdirP } from "node:fs/promises";

describe("runLoreSync 的 protagonist 落地", () => {
  async function setupWorld(): Promise<string> {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-prot-"));
    await mkdirP(path.join(worldDir, "characters"), { recursive: true });
    await writeFile(
      path.join(worldDir, "characters", "protagonist.md"),
      "# 主角檔案\n- 姓名：沈奕\n- 當前積分：5\n\n## 物品欄\n- 戰術刀\n",
      "utf8",
    );
    await writeFile(path.join(worldDir, "characters", "index.md"), "| ID | 姓名 |\n|----|------|\n", "utf8");
    return worldDir;
  }

  function planFor(worldDir: string): TurnPlan {
    return {
      messages: [],
      buildFastControl: () => [],
      buildLoreSync: () => [{ role: "system", content: "Layer 3 prompt" }],
      appendRaw: async () => {},
      rawFilePath: path.join(worldDir, "journal.md"),
    };
  }

  it("protagonist_points_delta=3 時：先 applyPointsDelta 落地積分，再 callProtagonistRewrite 覆寫", async () => {
    const worldDir = await setupWorld();
    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("Layer 3")) {
          yield JSON.stringify({ state_changes: { protagonist_points_delta: 3, protagonist_changed: true } });
        } else if (system.includes("主角檔案維護者")) {
          const user = messages.find((m) => m.role === "user")?.content ?? "";
          // 斷言：餵進來的現有全文積分已是 8（5+3 由引擎先算好）
          expect(user).toContain("當前積分：8");
          yield "# 主角檔案\n- 姓名：沈奕\n- 當前積分：8\n\n## 物品欄\n- 戰術刀\n- 生鏽鐵管\n";
        }
      },
    };
    const deps: TurnDeps = { client: fakeClient, worldDir, commit: async () => true, today: () => "2026-06-24" };
    await runLoreSync(deps, "沈奕撿起鐵管，完成測試得 3 分。", "設定", planFor(worldDir), logger);

    const prot = await readFile(path.join(worldDir, "characters", "protagonist.md"), "utf8");
    expect(prot).toContain("當前積分：8");
    expect(prot).toContain("生鏽鐵管");
  });

  it("delta=0 且 protagonist_changed=false 時：完全不重寫主角檔（內容不變）", async () => {
    const worldDir = await setupWorld();
    const before = await readFile(path.join(worldDir, "characters", "protagonist.md"), "utf8");
    let rewriteCalled = false;
    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("Layer 3")) {
          yield JSON.stringify({ state_changes: {} });
        } else if (system.includes("主角檔案維護者")) {
          rewriteCalled = true;
          yield "不該被呼叫";
        }
      },
    };
    const deps: TurnDeps = { client: fakeClient, worldDir, commit: async () => true, today: () => "2026-06-24" };
    await runLoreSync(deps, "沈奕只是看了看四周。", "設定", planFor(worldDir), logger);

    expect(rewriteCalled).toBe(false);
    const after = await readFile(path.join(worldDir, "characters", "protagonist.md"), "utf8");
    expect(after).toBe(before);
  });

  it("protagonist_changed=true 但 delta 缺省：積分不變，仍重寫（整合成長）", async () => {
    const worldDir = await setupWorld();
    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("Layer 3")) {
          yield JSON.stringify({ state_changes: { protagonist_changed: true } });
        } else if (system.includes("主角檔案維護者")) {
          const user = messages.find((m) => m.role === "user")?.content ?? "";
          expect(user).toContain("當前積分：5"); // 無 delta，積分照舊
          yield "# 主角檔案\n- 姓名：沈奕\n- 當前積分：5\n\n## 技能 / 異能\n- 近戰格鬥精通\n";
        }
      },
    };
    const deps: TurnDeps = { client: fakeClient, worldDir, commit: async () => true, today: () => "2026-06-24" };
    await runLoreSync(deps, "沈奕領悟近戰格鬥精通。", "設定", planFor(worldDir), logger);

    const prot = await readFile(path.join(worldDir, "characters", "protagonist.md"), "utf8");
    expect(prot).toContain("近戰格鬥精通");
    expect(prot).toContain("當前積分：5");
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/lore-sync.test.ts`
Expected: FAIL — 三個新測試紅（protagonist 尚未在 Layer 3 落地）。

- [ ] **Step 3: 改 runLoreSync**

在 `app/src/engine/turn/lore-sync.ts`：

(a) import 補上 `callProtagonistRewrite`、`applyPointsDelta`：

```typescript
import { addCharacterIndexRow, applyIndexStatusUpdates, applyPointsDelta, parseProtagonist, rewriteNpcFile } from "../context.js";
```
```typescript
import {
  ENTITY_CATEGORY_TO_LORE,
  callLoreRewrite,
  callProtagonistRewrite,
  rewriteLoreEntity,
  type LoreRewriteContext,
  type LoreRewriteResult,
} from "./lore-rewrite.js";
```

(b) 在 `loreContext` 宣告之後（約 line 113）、entity 重寫之前或之後皆可（與 entity 重寫互不依賴，放其後即可），新增 protagonist 落地段。注意 `readFile`/`writeFile` 已從 `node:fs/promises` 匯入（檔頂只 import 了 `writeFile`，需補 `readFile`）：

檔頂 import 改為：
```typescript
import { readFile, writeFile } from "node:fs/promises";
```

protagonist 落地（放在 `const results = [...]` 組裝之前）：

```typescript
    // protagonist 落地（Layer 權責重劃）：積分由引擎決定論先算，再整檔重寫整合成長。
    // delta 或 protagonist_changed 任一成立才動；兩者皆否完全跳過。
    const pointsDelta = changes.protagonist_points_delta ?? 0;
    const protagonistChanged = changes.protagonist_changed === true;
    let protagonistTouched = false;
    if (pointsDelta !== 0 || protagonistChanged) {
      const pPath = path.join(deps.worldDir, "characters", "protagonist.md");
      const before = await readBestEffort(pPath);
      if (before) {
        const withPoints = pointsDelta !== 0 ? applyPointsDelta(before, pointsDelta) : before;
        const rewritten = await callProtagonistRewrite(
          deps.loreClient ?? deps.controlClient ?? deps.client,
          settingText,
          narrative,
          withPoints,
          log,
          loreContext,
        );
        // 重寫成功用新版；失敗至少落地積分（withPoints），不丟分
        await writeFile(pPath, rewritten ?? withPoints, "utf8");
        protagonistTouched = true;
      } else {
        log.warn("protagonist.md 不存在，略過本回合主角落地");
      }
    }
```

(c) commit 條件擴充——把 `if (results.length > 0)` 改為涵蓋 protagonist：

```typescript
    if (results.length > 0 || protagonistTouched) {
      const committed = await deps.commit("補完關聯文件（主角/NPC/道具/場景/技能）");
      log.info({ committed }, "回合結束（Layer 3 reactive-lore-sync）");
    } else {
      log.debug("Layer 3 reactive-lore-sync 本回合無 lore 異動，跳過 commit");
    }
```

(d) recall 重建（若有 `deps.recall`）把 protagonist.md 也納入——在既有 `if (deps.recall)` 區塊內，`touched` 陣列組好後補：

```typescript
      if (protagonistTouched) touched.push(path.join(deps.worldDir, "characters", "protagonist.md"));
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/lore-sync.test.ts`
Expected: PASS（新三測 + 既有測試全綠）。

- [ ] **Step 5: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/turn/lore-sync.ts app/src/engine/turn/lore-sync.test.ts
git commit -m "feat(lore-sync): Layer 3 接手 protagonist 落地（積分決定論 + 整檔重寫）"
```

---

## Task 4: 移除 turn-core 的 Layer 2 protagonist 落地

**Files:**
- Modify: `app/src/engine/turn/turn-core.ts:5-6,40-53,144-162`
- Test: `app/src/engine/turn/index.test.ts`、`app/src/engine/turn/traditionalize-control.test.ts`

**Interfaces:**
- Consumes: Task 1 後的 `FastControl`（無 protagonist 欄位）、Task 3 後的 Layer 3 protagonist 落地。
- Produces: `runTurnCore` 不再寫 protagonist.md；`traditionalizeFastControl` 不再處理 `protagonist_updates`。

- [ ] **Step 1: 改既有測試（migrate，先讓它們反映新行為 → 紅）**

在 `app/src/engine/turn/index.test.ts`：

把 line 234 的測試「protagonist_updates 落地到 protagonist.md」整段**改寫**為「Layer 2 不再落地 protagonist，改由 Layer 3」——因 index.test.ts 跑的是完整 `runMainSpaceTurn`（含 Layer 3），積分/成長最終仍會落地，但來源改成 Layer 3 的欄位。改寫該 `it(...)`：

```typescript
  it("主角成長改由 Layer 3 落地（積分 + 技能/物品整合進 protagonist.md）", async () => {
    await writeFile(
      path.join(world, "characters", "protagonist.md"),
      ["# 主角", "- 姓名：沈奕", "- 當前積分：0", "", "## 技能 / 異能", "- （無）", "", "## 物品欄", "- 戰術刀", ""].join("\n"),
      "utf8",
    );
    await writeFile(path.join(world, "characters", "index.md"), "| ID | 姓名 |\n|----|------|\n", "utf8");
    // Layer 2 只出顯示欄位；Layer 3 出 protagonist 變化
    const fc = JSON.stringify({
      state_changes: { now: { scene: "訓練場" } },
      rolls: [], mode_transition: null, awaiting_user_input: true,
      suggested_actions: [], commit_summary: "沈奕成長",
    });
    const ls = JSON.stringify({
      state_changes: { protagonist_points_delta: 1, protagonist_changed: true },
    });
    // fakeClient 依 system prompt 內容回不同層；主角重寫回整檔新版
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("Layer 3：reactive-lore-sync") || system.includes("reactive-lore-sync")) { yield ls; return; }
        if (system.includes("主角檔案維護者")) {
          yield "# 主角\n- 姓名：沈奕\n- 當前積分：1\n\n## 技能 / 異能\n- 近戰格鬥精通\n\n## 物品欄\n- 戰術刀\n- 生鏽鐵管\n";
          return;
        }
        if (system.includes("fast-control")) { yield fc; return; }
        yield "沈奕領悟近戰格鬥精通，撿起鐵管。"; // 主腦敘事
      },
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      { client, worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [1] },
      "練習格鬥",
    )) {
      events.push(ev);
    }
    const prot = await readFile(path.join(world, "characters", "protagonist.md"), "utf8");
    expect(prot).toContain("- 當前積分：1");
    expect(prot).toContain("近戰格鬥精通");
    expect(prot).toContain("生鏽鐵管");
  });
```

> 對 line 120「串流敘事、副大腦套用 now/積分」與 line 768、161 等仍斷言「Layer 2 落地積分」的測試：把積分斷言改為由 Layer 3 欄位驅動（同上模式），或在該測試的 fake client 補 Layer 3 回 `protagonist_points_delta`。先 `cd app && grep -n "當前積分\|protagonist_points_delta" src/engine/turn/index.test.ts` 列出所有點，逐一改成新流。**保留** `protagonist_permanent_death` 相關測試不動。

在 `app/src/engine/turn/traditionalize-control.test.ts`：移除「繁體化 protagonist_updates 各項」的斷言（line 32-45 的 `protagonist_updates` 部分），因該欄位已不在 FastControl。保留 `now` 各欄繁體化斷言。

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts src/engine/turn/traditionalize-control.test.ts`
Expected: FAIL — turn-core 仍走舊 Layer 2 落地 / 仍引用已移除欄位（typecheck 也會紅）。

- [ ] **Step 3: 移除 turn-core 舊落地**

在 `app/src/engine/turn/turn-core.ts`：

(a) import（line 5-6）移除 `applyProtagonistUpdates`（保留 `applyPointsDelta`？——turn-core 不再用它，一併移除 import；`loadState`、`applyNowChanges` 等保留）：

```typescript
import { loadState, type GameState } from "../context.js";
```
> 先確認 turn-core 其他處沒用到 `applyPointsDelta`/`applyProtagonistUpdates`：`cd app && grep -n "applyPointsDelta\|applyProtagonistUpdates" src/engine/turn/turn-core.ts`。本計畫預期僅 line 5-6,150-151 使用，全數移除。

(b) `traditionalizeFastControl`（line 40-53）移除 `protagonist_updates` 一行：

```typescript
export function traditionalizeFastControl(control: FastControl): FastControl {
  const sc = control.state_changes;
  return {
    ...control,
    commit_summary: toTraditional(control.commit_summary),
    suggested_actions: control.suggested_actions.map(toTraditional),
    rolls: control.rolls.map((r) => ({ ...r, desc: toTraditional(r.desc) })),
    state_changes: {
      ...sc,
      now: traditionalizeStringBag(sc.now),
    },
  };
}
```

(c) 移除整個「3. 主角狀態」落地段（line 144-153）。`reindexTouchedFiles` 的 touched（line 155-162）移除 protagonist 條件，只保留 rawFilePath：

```typescript
  // 4. 語意檢索索引：把本回合異動的 raw 檔重新切塊嵌入（protagonist 改由 Layer 3 重建）
  if (deps.recall) {
    await reindexTouchedFiles(deps.recall, deps.worldDir, [plan.rawFilePath], log);
  }
```

> `protagonist_permanent_death` 段（line 176-187）**完全保留不動**。

- [ ] **Step 4: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/index.test.ts src/engine/turn/traditionalize-control.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量 typecheck + 測試**

Run: `cd app && npm run typecheck && npx vitest run`
Expected: typecheck clean；全測試綠（Task 1 留下的下游錯誤此時應全清）。

- [ ] **Step 6: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/turn/turn-core.ts app/src/engine/turn/index.test.ts app/src/engine/turn/traditionalize-control.test.ts
git commit -m "refactor(turn-core): 移除 Layer 2 protagonist 落地（移交 Layer 3）"
```

---

## Task 5: prompts 收緊（移除 Layer 2 protagonist 欄位、Layer 3 新增 protagonist + id 直譯規則）

**Files:**
- Modify: `app/src/engine/turn/prompts.ts:30-46`（FAST_CONTROL_FORMAT_BLOCK）、`47-60`（LORE_SYNC_FORMAT_BLOCK）
- Test: `app/src/engine/turn/prompts.test.ts`

**Interfaces:**
- Consumes: 既有 format block 常數。
- Produces: Layer 2 prompt 不再提 protagonist_*；Layer 3 prompt 含 protagonist_points_delta/protagonist_changed 說明 + id 直譯規則 + 反例。

- [ ] **Step 1: 寫失敗測試**

在 `app/src/engine/turn/prompts.test.ts`：

`buildFastControlMessages` 區塊新增：

```typescript
  it("Layer 2 不再含 protagonist_updates / protagonist_points_delta 欄位說明", () => {
    const msgs = buildFastControlMessages({
      settingText: "設定", state: sampleState, input: "看看四周",
      narrative: "沈奕環顧四周。", dicePool: [1],
    });
    expect(msgs[0].content).not.toContain("protagonist_updates");
    expect(msgs[0].content).not.toContain("protagonist_points_delta");
  });
```

`buildLoreSyncMessages` 區塊新增：

```typescript
  it("Layer 3 含 protagonist_points_delta / protagonist_changed 欄位說明", () => {
    const msgs = buildLoreSyncMessages({
      settingText: "設定", state: sampleState, input: "練格鬥",
      narrative: "沈奕得 2 分並領悟新技能。", dicePool: [1],
    });
    expect(msgs[0].content).toContain("protagonist_points_delta");
    expect(msgs[0].content).toContain("protagonist_changed");
  });

  it("Layer 3 含 id 直譯規則與反例（根因 Bug 2）", () => {
    const msgs = buildLoreSyncMessages({
      settingText: "設定", state: sampleState, input: "辨識震動",
      narrative: "沈奕練成辨識震動。", dicePool: [1],
    });
    expect(msgs[0].content).toContain("直譯");
    expect(msgs[0].content).toContain("identify_vibration");
    expect(msgs[0].content).toContain("system_monitor"); // 作為反例出現
  });
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd app && npx vitest run src/engine/turn/prompts.test.ts`
Expected: FAIL — Layer 2 仍含 protagonist 欄位；Layer 3 無 protagonist 欄位、無 id 直譯規則。

- [ ] **Step 3: 改 FAST_CONTROL_FORMAT_BLOCK**

移除 `protagonist_points_delta` 與 `protagonist_updates` 兩行及其註解行，`state_changes` 只剩 `now`。**不要新增 `protagonist_permanent_death` 說明行**——已確認該欄位不在此 block 中（它是 schema `.default(false)` 欄位，不在 prompt 描述），維持現狀：

```typescript
const FAST_CONTROL_FORMAT_BLOCK = [
  "## 輸出格式（務必嚴格遵守）",
  `所有中文字串值一律使用繁體中文與台灣用詞（${TRADITIONAL_CHINESE_RULE}）。`,
  "只輸出**單一 JSON 物件**，不要任何前言、後語或程式碼框。JSON 必須包含以下頂層（top-level）欄位：",
  "- state_changes: {",
  "    now?: { chapter?, scene?, companions?, threads?, nextStep? } （注意：進行中的副本欄由引擎依 mode_transition 自動管理，不可透過 now.activeDungeon 自行覆寫） }",
  "- rolls: [{desc, value, success?}]（敘事中實際用到的骰值與判定，沒有就空陣列）",
  '- mode_transition: null | "enter_dungeon" | "settle_dungeon"',
  "- transition_dungeon_id / transition_dungeon_goal：配合 enter_dungeon 才填",
  "- awaiting_user_input: boolean —— 敘事屬純環境/系統旁白/NPC 自行動作、玩家不需做決定時設 false；需要玩家選擇才設 true。",
  "- suggested_actions: string[]",
  "- commit_summary: string （一句摘要）",
].join("\n");
```

- [ ] **Step 4: 改 LORE_SYNC_FORMAT_BLOCK**

(a) `state_changes` 欄位列表加上 protagonist 兩欄；(b) id 說明補直譯規則 + 反例：

```typescript
const LORE_SYNC_FORMAT_BLOCK = [
  "## 輸出格式（務必嚴格遵守）",
  `所有中文字串值一律使用繁體中文與台灣用詞（${TRADITIONAL_CHINESE_RULE}）。`,
  "只輸出**單一 JSON 物件**，不要任何前言、後語或程式碼框。欄位：",
  "- state_changes: { touched_entities?: [{id, category, name, excerpt}], dungeon_wiki_excerpt?: string, protagonist_points_delta?: number, protagonist_changed?: boolean }",
  "  - touched_entities：本回合敘事中明確登場、或知識被進一步揭露/訂正的 NPC、道具、場景、技能。",
  "    category 只能是 npc/item/location/skill 其中之一；id 用小寫英數 slug，單字以底線分隔（snake_case）；",
  "    **id 必須是 name 的英文直譯**，例如「辨識震動」→ identify_vibration、「碰撞警報裝置」→ collision_alarm_device；" +
    "不可用系統視角的功能描述詞（如 system_monitor、handler、manager、detector）取代實體本身的名字；不可用中文、空白或純標點；name 用顯示名稱；",
  "    excerpt 是本回合敘事中跟這個實體有關的原文片段（之後會有另一步驟拿這段片段去跟現有檔案比較、",
  "    決定怎麼更新，你不需要自己組好最終的完整內容，只要把相關原文片段填進來）。",
  "  - dungeon_wiki_excerpt：劇情中對**當前副本本身**新揭露的知識片段（地圖/機關/規則），不在副本中則省略。",
  "  - protagonist_points_delta：本回合主角積分的增減量（敘事明確發生才填，沒有就省略或 0）。",
  "  - protagonist_changed：本回合敘事是否涉及主角屬性/技能/物品/buff 的變化（有就 true，純積分變動或無變化則省略/false）。",
  "（本回合若沒有任何相關異動，對應欄位省略即可，不要硬湊內容）",
].join("\n");
```

- [ ] **Step 5: 跑測試確認通過**

Run: `cd app && npx vitest run src/engine/turn/prompts.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/turn/prompts.ts app/src/engine/turn/prompts.test.ts
git commit -m "feat(prompts): Layer 2 移除 protagonist 欄位，Layer 3 加 protagonist 欄位與 id 直譯規則"
```

---

## Task 6: 清除 dead code（applyProtagonistUpdates / appendToSection / normalizeItem）

**Files:**
- Modify: `app/src/engine/context.ts:166-227`
- Test: `app/src/engine/context.test.ts:163-217`

**Interfaces:**
- Consumes: 無（這是清理）。
- Produces: `context.ts` 不再 export `applyProtagonistUpdates`；`appendToSection`/`normalizeItem` 一併刪除。`applyPointsDelta` **保留**（Task 3 在 lore-sync 用）。`ProtagonistUpdates` 型別若無其他引用一併刪除。

- [ ] **Step 1: 確認無生產引用**

Run:
```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && grep -rn "applyProtagonistUpdates\|appendToSection\|normalizeItem\|ProtagonistUpdates" src --include="*.ts" | grep -v "\.test\.ts"
```
Expected: 只剩 `context.ts` 內部定義（Task 4 已移除 turn-core 的 import）。若仍有其他生產引用，先處理那些引用再繼續。

- [ ] **Step 2: 移除 context.test.ts 對應測試**

刪除 `app/src/engine/context.test.ts` 的整個 `describe("applyProtagonistUpdates", ...)` 區塊（line 163-217），並移除檔頂 import 的 `applyProtagonistUpdates`（line 12）。**保留** `applyPointsDelta` 的 import 與其 `describe`（line 153-160）。

- [ ] **Step 3: 跑測試確認（紅：import 不存在）**

Run: `cd app && npx vitest run src/engine/context.test.ts`
Expected: 此時測試檔已不引用被刪函式，應可跑——但若 Step 4 尚未刪函式，測試仍綠。本步驟主要確認移除測試後無遺留引用編譯錯誤：`cd app && npm run typecheck`（context.ts 仍 export 該函式，typecheck 仍綠）。

- [ ] **Step 4: 刪 dead code**

在 `app/src/engine/context.ts` 刪除：
- `normalizeItem`（line 166-169）
- `appendToSection`（line 171-210）
- `applyProtagonistUpdates`（line 219-227）
- `ProtagonistUpdates` interface（line 212-217）—— 先確認無其他引用（Step 1 已含）。

保留 `applyPointsDelta`（line 157-163）。

- [ ] **Step 5: 全量 typecheck + 測試**

Run: `cd app && npm run typecheck && npx vitest run`
Expected: typecheck clean；全測試綠。

- [ ] **Step 6: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/context.ts app/src/engine/context.test.ts
git commit -m "refactor(context): 移除 protagonist delta-append dead code（已改全檔重寫）"
```

---

## Task 7: 端對端驗證

**Files:** 無（驗證任務）

- [ ] **Step 1: 全量綠燈**

Run: `cd app && npm run typecheck && npx vitest run`
Expected: typecheck clean；全測試通過。

- [ ] **Step 2: 起 dev server 跑 ≥10 回合**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npm run dev
```
另開流程對 `http://localhost:5173/api/turn` 送 ≥10 次輸入（或用 UI）。觀察 `journal_summary.md` ≥10 筆。

- [ ] **Step 3: 人工檢查 world/ 落地（核對 spec 驗證項）**

- `world/characters/protagonist.md`：屬性/物品**無重複條目**（Bug 1 根治）。
- 新技能/實體目錄 id 與 name **英文直譯對應**（無 `system_monitor` 式語意錯位，Bug 2）。
- 新建 wiki / 角色檔**無 raw 敘事散文 / 系統提示殘留**（無【系統公告】整段照抄，Bug 4/5）。
- 積分正確累計（**延遲一回合**反映面板——當回合 done 顯示舊值，下一回合開始 loadState 正確）。
- `.server.log` 中 Layer 2 `回合結束（Layer 2）` 全為 INFO、無 JSON parse ERROR。

- [ ] **Step 4: 還原驗證產物**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git checkout -- world/ && git clean -fd world/
```

- [ ] **Step 5: 最終 commit（若驗證中有微調）**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/
git commit -m "test: 端對端驗證 Layer 權責重劃（10 回合）"
```

---

## Self-Review（plan 作者已執行）

**Spec coverage：**
- ✅ §1 架構與責任邊界 → Task 1（schema）+ Task 4（turn-core 移除）+ Task 5（prompts）
- ✅ §1 積分延遲一回合、零前端改動 → 無 server/web 改動 task（刻意）；Task 7 Step 3 驗證延遲行為
- ✅ §1 protagonist_permanent_death 保留 → Global Constraints + Task 4 Step 3 明示不動
- ✅ §2 protagonist 全檔重寫 → Task 2（callProtagonistRewrite）+ Task 3（編排）
- ✅ §2 積分決定論先落地 → Task 3 Step 3 (b) `applyPointsDelta(before, delta)` 後才重寫
- ✅ §2 觸發條件 protagonist_changed → Task 1（schema）+ Task 3（delta || changed）
- ✅ §2 移除 applyProtagonistUpdates/appendToSection → Task 6
- ✅ §3 Bug 2 id 直譯 → Task 5 Step 4
- ✅ §3 Bug 4/5 禁照搬 → Task 2 Step 3（callLoreRewrite）+ Task 2 Step 4（callProtagonistRewrite 同款鐵則）
- ✅ 測試表所列檔案 → Task 1/2/3/4/5/6 對應

**Placeholder scan：** 無 TBD/TODO；每個 code step 附完整程式碼。少數「先 grep 確認」步驟是針對 main 上可能已微調的常數（如 `protagonist_permanent_death` 是否已在 FAST_CONTROL_FORMAT_BLOCK），給實作者明確的確認指令而非模糊指示。

**Type consistency：** `callProtagonistRewrite` 簽名在 Task 2 定義、Task 3 依該簽名呼叫（6 參數，context 選填）。`protagonist_changed`/`protagonist_points_delta` 在 Task 1 定型、Task 3/5 一致引用。`applyPointsDelta` 全程保留、簽名不變。

**Scope：** 單一 plan，聚焦引擎三檔 + schema + prompts + 測試，無跨子系統。
