# Lore Rewrite 骨架注入 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 lore entity 全新建檔時，把對應的世界特定 template 骨架注入 `callLoreRewrite` 的 system prompt，讓 LLM 知道這種類型的 wiki 應包含哪些段落。

**Architecture:**
`callLoreRewrite` 加一個 `scaffoldContent?: string` 選用參數，當 `existingContent` 為空且有 scaffold 時，在 system prompt 末尾加入骨架說明。`rewriteLoreEntity` 對非 NPC entity 且 wiki 為空時，從 `path.dirname(deps.worldDir)` 推算 `repoRoot`，呼叫 `getTemplate(category, worldDir, repoRoot)` 取得骨架；失敗則 warn 並繼續（骨架是 nice-to-have，不可中斷 lore 流程）。NPC 不注入骨架。

**Tech Stack:** TypeScript, Vitest

## Global Constraints

- TypeScript，無 `any`，`tsc --noEmit` 零錯誤
- 全套 `cd app && npx vitest run` 通過
- 骨架注入**只在全新建檔**（`existingContent === ""`）時生效；更新既有文件時不注入（骨架段落不覆蓋已有事實）
- `getTemplate` 失敗時 warn 並繼續，不拋錯，不中斷 lore rewrite
- NPC 不注入骨架
- `TurnDeps` 型別不改動
- `repoRoot` 從 `path.dirname(deps.worldDir)` 推算，不加新參數

---

## 檔案對應

**修改：**
- `app/src/engine/turn/lore-rewrite.ts`
- `app/src/engine/turn/lore-rewrite.test.ts`

---

## Task 1：骨架注入

**Interfaces:**
- `callLoreRewrite(client, settingText, excerpt, docTitle, existingContent, category, log, context?, scaffoldContent?)` — 新增最後一個選用參數
- `rewriteLoreEntity(deps, settingText, entity, log, context?)` — 簽名不變，內部加骨架查找邏輯

- [ ] **Step 1: 確認基線**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/turn/lore-rewrite.test.ts
```

Expected: PASS

- [ ] **Step 2: 修改 `callLoreRewrite` — 加 `scaffoldContent` 參數**

在 `lore-rewrite.ts` 的 `callLoreRewrite` 函式，加第 9 個選用參數，並在 system prompt 的「全新建檔」條件下注入骨架：

```typescript
export async function callLoreRewrite(
  client: LlmClient,
  settingText: string,
  excerpt: string,
  docTitle: string,
  existingContent: string,
  category: LoreRewriteCategory,
  log: Logger,
  context?: LoreRewriteContext,
  scaffoldContent?: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是「無限恐怖」世界敘事引擎的知識庫維護者。任務：把【現有文件】依【本回合敘事片段】更新成一份完整、連貫的新版內容。",
        "",
        "語言與用詞：",
        `- ${TRADITIONAL_CHINESE_RULE}`,
        "",
        "這份文件常見的可寫面向（不是每筆都要填滿；本回合片段沒提到、也沒有合理依據可擴寫的面向不要硬湊）：",
        LORE_REWRITE_CATEGORY_OUTLINE[category],
        "",
        // 全新建檔且有骨架時，注入骨架段落說明
        ...(!existingContent.trim() && scaffoldContent
          ? [
              "文件骨架（段落標題固定，依敘事片段填入對應段落；片段未提及的段落留空）：",
              scaffoldContent.trim(),
              "",
            ]
          : []),
        "鐵則：",
        "- 只輸出文件完整新版內容本身（純文字/Markdown），不要 JSON、不要前言、不要程式碼框。",
        "- 若【現有文件全文】非空（更新既有文件）：不可遺漏現有文件中仍然成立的事實；只在片段明確提供新資訊或訂正時才改動對應部分；不可發明片段未提及的事實。",
        "- 若目前沒有現有文件（全新建檔）：只依本回合敘事片段已明確描述的內容整理成檔；**不可發明、不可擴寫敘事未提供的任何細節**（含視覺風格、材質、光線、氣味、用途、效果、機關、來歷、與人物事件的關聯）。片段沒提到的面向就留白，不要硬填、不要為了畫面感而想像。後續敘事揭露更多時再補。",
        "- 輸出是**整理過的知識條目**，不是敘事轉貼。禁止把本回合敘事片段的散文、對白、系統提示（如【系統公告】【副本載入完畢】【系統提示】）原文照搬進文件；只能把片段中的事實**提煉**成條列式設定描述。文件中不應出現「本回合」「沈奕這時」這類敘事時序語句。",
        "",
        "世界設定：",
        settingText.trim(),
      ].join("\n"),
    },
    // ... user message 不變
  ];
  // ... 其餘不變
}
```

- [ ] **Step 3: 修改 `rewriteLoreEntity` — 非 NPC 全新建檔時查找骨架**

在 `rewriteLoreEntity` 的非 NPC 分支，找到讀取 `existing.wiki` 之後、呼叫 `callLoreRewrite` 之前，加入骨架查找：

```typescript
import { getTemplate } from "../template-loader.js";
import path from "node:path";

// 在 existing.wiki 讀取之後：
const categoryType = entity.category; // "item" | "scene" | "skill"
let scaffoldContent: string | undefined;
if (!existing.wiki) {
  // 全新建檔時注入骨架（失敗則 warn 並繼續，骨架是 nice-to-have）
  const repoRoot = path.dirname(deps.worldDir);
  try {
    scaffoldContent = await getTemplate(categoryType, deps.worldDir, repoRoot);
  } catch (err) {
    log.warn({ err, category: categoryType }, "getTemplate 失敗，略過骨架注入");
  }
}

// 呼叫 callLoreRewrite 時傳入 scaffoldContent：
const content = await callLoreRewrite(
  rewriteClient, settingText, entity.excerpt, title, existing.wiki,
  entity.category, log, context, scaffoldContent,
);
```

注意：`dungeon` wiki 走的是 `dungeon_wiki_excerpt` 路徑，在 `lore-sync.ts` 直接呼叫 `rewriteLoreWiki`，不走 `rewriteLoreEntity`。所以 `dungeon` category 在此不需特別處理。

- [ ] **Step 4: 更新 `lore-rewrite.test.ts` — 補骨架注入測試**

在 `callLoreRewrite` 的測試區塊新增：

```typescript
it("全新建檔且有 scaffoldContent 時，system prompt 含骨架內容", async () => {
  const cap = capturingClient("新版內容");
  await callLoreRewrite(
    cap.client, "世界設定", "片段", "標題", "",
    "item", logger, undefined, "## 品質等級\n<!-- 填入 -->\n## 效果/說明\n<!-- 填入 -->",
  );
  const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
  expect(system).toContain("## 品質等級");
  expect(system).toContain("文件骨架（段落標題固定");
});

it("existingContent 非空時不注入骨架，即使有 scaffoldContent", async () => {
  const cap = capturingClient("新版內容");
  await callLoreRewrite(
    cap.client, "世界設定", "片段", "標題", "# 現有內容\n\n已有文件",
    "item", logger, undefined, "## 品質等級\n<!-- 填入 -->",
  );
  const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
  expect(system).not.toContain("文件骨架（段落標題固定");
});
```

在 `rewriteLoreEntity` 測試新增（需要建立 `templates/item.md`）：

```typescript
it("全新建檔時 system prompt 含骨架內容（來自 getTemplate）", async () => {
  const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
  // 建全域骨架
  const repoRoot = path.dirname(worldDir);
  await mkdir(path.join(repoRoot, "templates"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "templates", "item.md"),
    "# 道具：{{道具名稱}}\n\n## 品質等級\n<!-- 填入 -->\n## 效果/說明\n<!-- 填入 -->",
    "utf8",
  );
  await mkdir(path.join(worldDir, "items", "iron-sword"), { recursive: true });

  const messages: ChatMessage[] = [];
  const capClient: LlmClient = {
    async *streamChat(msgs: ChatMessage[]) {
      messages.push(...msgs);
      yield msgs.find((m) => m.role === "system")?.content?.includes("劇透文件")
        ? "隱藏設定"
        : "## 品質等級\n普通\n## 效果/說明\n造成傷害";
    },
  };
  const deps: TurnDeps = { client: capClient, worldDir, commit: async () => true };

  await rewriteLoreEntity(
    deps, "世界設定",
    { id: "iron-sword", category: "item", name: "鐵劍", excerpt: "主角撿到一把鐵劍" },
    logger,
  );

  const systemMsg = messages.find((m) => m.role === "system" && !m.content.includes("劇透文件"))?.content ?? "";
  expect(systemMsg).toContain("文件骨架（段落標題固定");
  expect(systemMsg).toContain("## 品質等級");

  // cleanup
  await rm(worldDir, { recursive: true, force: true });
  await rm(path.join(repoRoot, "templates"), { recursive: true, force: true });
});
```

確認 test 檔頂部已 import `writeFile`、`rm`（補充需要的 import）。

- [ ] **Step 5: 執行測試**

```bash
cd /Users/kk/projects/Inifinity-world-adventure/app && npx vitest run src/engine/turn/lore-rewrite.test.ts
```

Expected: PASS（新增 3 個測試通過）

- [ ] **Step 6: 執行全套 + tsc**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: 全套通過，tsc 零錯誤

- [ ] **Step 7: Commit**

```bash
cd /Users/kk/projects/Inifinity-world-adventure
git add app/src/engine/turn/lore-rewrite.ts app/src/engine/turn/lore-rewrite.test.ts
git commit -m "feat(engine): lore 全新建檔時注入世界特定 template 骨架"
```

---

## 自審 Checklist

**Spec 覆蓋：**
- [x] `callLoreRewrite` 加 `scaffoldContent?` 參數 — Step 2
- [x] 骨架只在全新建檔（`existingContent === ""`）時注入 — Step 2
- [x] `rewriteLoreEntity` 查找骨架（`getTemplate` fallback） — Step 3
- [x] `getTemplate` 失敗時 warn 並繼續 — Step 3
- [x] NPC 不注入骨架 — Step 3（只在非 NPC 分支）
- [x] `TurnDeps` 不改 — Step 3（從 `path.dirname(deps.worldDir)` 推算）
- [x] 測試覆蓋 scaffold 注入、不注入、getTemplate 整合 — Step 4

**Placeholder 掃描：** 無 TBD/TODO

**型別一致性：**
- `callLoreRewrite` 新增第 9 個參數，所有現有呼叫端不傳此參數 → TypeScript 允許（選用參數），不需改呼叫端
