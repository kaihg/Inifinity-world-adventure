# Remove Static Opening from initWorld — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 從 `initWorld` 移除靜態 opening 生成，讓開場敘事完全由已有的 opening turn pipeline 負責，修正 journal.md 雙段 opening 問題（Issue 6 + 7）。

**Architecture:** `world-ops.ts` 的 `initWorld` 目前生成 4 個 LLM call（setting / protagonist / gm-notes / opening），其中 opening 與後來 opening turn pipeline 重複。移除 opening 的 template 讀取、LLM call、以及 journal.md 初始內容裡的靜態敘事；`journal.md` 改為只含標題行，opening turn（已實作，走標準 pipeline）自然補入第一段敘事。

**Tech Stack:** TypeScript、Node.js、Vitest（`npm test` in `app/`）

## Global Constraints

- 不動 `turn/index.ts`、`templates/opening.md`、前端任何檔案
- 不動 `world-id.ts`（Issue 9 UUID 另立 spec）
- Vitest 測試語法對齊 `app/src/engine/world-ops.test.ts` 現有慣例
- 繁體中文測試字串對齊現有慣例

---

## 檔案異動總覽

| 檔案 | 動作 |
|------|------|
| `app/src/engine/world-ops.ts` | 修改：移除 openingScaffold 讀取、openingMd 生成、journal.md 靜態 opening 內容 |
| `app/src/engine/world-ops.test.ts` | 修改：移除舊 opening 測試、新增 journal 只含標題行的測試 |

---

## Task 1：移除靜態 opening 生成並更新測試

**Files:**
- Modify: `app/src/engine/world-ops.ts`（步驟 1 template 讀取、步驟 4 LLM 生成、步驟 5 journal.md 寫入）
- Test: `app/src/engine/world-ops.test.ts`

**Interfaces:**
- Consumes: 無新介面，只移除現有程式碼
- Produces: `initWorld` 完成後 `journal.md` = `# 主空間日誌（Journal）\n`（只含標題行）

---

- [ ] **Step 1: 撰寫失敗測試**

在 `app/src/engine/world-ops.test.ts` 的 `describe("initWorld 骨架注入")` 區塊末尾（第 303 行 `});` 前），新增以下測試：

```typescript
it("journal.md 初始只含標題行，不含任何 ## 回合段落", async () => {
  const client: LlmClient = {
    async *streamChat(messages: ChatMessage[]) {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("設定設計師")) { yield "# 世界設定（World Setting）\n\n冷酷系統。\n"; return; }
      if (system.includes("角色設計師")) { yield "# 主角檔案\n\n沈奕。\n"; return; }
      yield "# 內容\n";
    },
  };
  await initWorld({ worldDir, repoRoot, client, input: {}, today: "2026-06-30", logger: createLogger() });

  const journal = await readFile(path.join(worldDir, "journal.md"), "utf8");
  expect(journal.trim()).toBe("# 主空間日誌（Journal）");
  expect(journal).not.toMatch(/^## /m);
});
```

- [ ] **Step 2: 跑新測試確認它失敗**

```bash
cd app && npm test -- --reporter=verbose src/engine/world-ops.test.ts 2>&1 | grep -E "journal.md 初始|FAIL|PASS|Tests"
```

Expected：`journal.md 初始只含標題行` FAIL（目前 journal.md 含靜態 opening）

- [ ] **Step 3: 移除 `openingScaffold` 的 template 讀取**

在 `app/src/engine/world-ops.ts` 找到步驟 1 的平行讀取（約第 66–70 行）：

```typescript
// 改前
const [settingScaffold, characterScaffold, openingScaffold] = await Promise.all([
  getTemplate("setting", worldDir, repoRoot),
  getTemplate("character", worldDir, repoRoot),
  getTemplate("opening", worldDir, repoRoot),
]);
```

改為：

```typescript
// 改後
const [settingScaffold, characterScaffold] = await Promise.all([
  getTemplate("setting", worldDir, repoRoot),
  getTemplate("character", worldDir, repoRoot),
]);
```

- [ ] **Step 4: 移除步驟 4 的 `openingMd` LLM call**

找到步驟 4 的平行生成（約第 119–144 行）：

```typescript
// 改前
const [gmNotesMd, openingMd] = await Promise.all([
  generateText(client, [
    {
      role: "system",
      content:
        "你是本世界的暗線設計師。依玩家可見的 setting.md，自主編寫世界隱藏真相 gm-notes.md（繁體中文）：" +
        "主神真實動機、世界背後真相、最終目的、暗線伏筆。這是劇透文件，玩家永遠不會直接看到。" +
        "只輸出 markdown 正文，開頭是 `# 世界隱藏真相（GM Notes）`。",
    },
    { role: "user", content: `玩家可見設定如下：\n\n${settingMd}` },
  ]),
  generateText(client, [
    {
      role: "system",
      content:
        "你是本世界的開場敘事設計師。依玩家可見的 setting.md 與 protagonist.md，" +
        "寫一段開場敘事（繁體中文）：主角在原世界的處境、以及被選中拉入主神空間瞬間的經過。\n" +
        "重要限制：開場敘事只描寫主角離開原世界的那一刻，**不可讓主角帶任何現實道具進入主神空間**；" +
        "若角色有天賦或被動能力，可自然流露，但道具、武器、裝備均留在原世界。" +
        "道具的鑑定與記錄會在進入主神空間後的第一個回合由系統處理，開場不需提及。\n" +
        "只輸出敘事正文本身，不要加標題、不要條列、不要前言。長度約 500-1000 字的連續散文，第三人稱。\n\n" +
        "以下是此世界的額外寫作參考（若有）：\n\n" + openingScaffold,
    },
    { role: "user", content: `世界設定：\n\n${settingMd}\n\n---\n\n主角檔案：\n\n${protagonistMd}` },
  ]),
]);
```

改為：

```typescript
// 改後
const gmNotesMd = await generateText(client, [
  {
    role: "system",
    content:
      "你是本世界的暗線設計師。依玩家可見的 setting.md，自主編寫世界隱藏真相 gm-notes.md（繁體中文）：" +
      "主神真實動機、世界背後真相、最終目的、暗線伏筆。這是劇透文件，玩家永遠不會直接看到。" +
      "只輸出 markdown 正文，開頭是 `# 世界隱藏真相（GM Notes）`。",
  },
  { role: "user", content: `玩家可見設定如下：\n\n${settingMd}` },
]);
```

- [ ] **Step 5: 修改步驟 5 的 `journal.md` 寫入**

找到 `journal.md` 的 `writeFile`（約第 157–161 行）：

```typescript
// 改前
await writeFile(
  path.join(worldDir, "journal.md"),
  `# 主空間日誌（Journal）\n\n## [${today}] 新世界啟用\n\n${openingMd}\n`,
  "utf8",
);
```

改為：

```typescript
// 改後
await writeFile(
  path.join(worldDir, "journal.md"),
  `# 主空間日誌（Journal）\n`,
  "utf8",
);
```

- [ ] **Step 6: 跑 TypeScript 型別檢查**

```bash
cd app && npm run typecheck 2>&1 | head -20
```

Expected：無型別錯誤（`openingScaffold`、`openingMd` 已不再被引用）

- [ ] **Step 7: 移除舊的 opening 敘事測試**

在 `app/src/engine/world-ops.test.ts` 找到並完整刪除以下測試（約第 259–289 行）：

```typescript
it("journal.md 第一筆記錄是依 setting+protagonist 生成的開場敘事，不是制式文字", async () => {
  // ... 整個 it block 刪除
});
```

- [ ] **Step 8: 跑全套測試確認通過**

```bash
cd app && npm test 2>&1 | tail -15
```

Expected：全部 pass（包含 Step 1 新增的 `journal.md 初始只含標題行` 測試）

若有意外失敗，檢查 `world-ops.test.ts` 裡其他測試的 fake client 是否有 `system.includes("開場敘事")` 分支——這些分支現在永遠不會被觸發，但不影響測試結果（多餘的 if 不是錯誤）。

- [ ] **Step 9: Commit**

```bash
git add app/src/engine/world-ops.ts app/src/engine/world-ops.test.ts
git commit -m "feat: remove static opening generation from initWorld, let opening turn handle first narrative"
```

---

## Self-Review

**1. Spec 覆蓋：**
- 移除 `openingScaffold` 讀取 → Step 3 ✓
- 移除 `openingMd` LLM call → Step 4 ✓
- `journal.md` 改為只含標題行 → Step 5 ✓
- 移除舊 opening 測試 → Step 7 ✓
- 新增 journal 只含標題行測試 → Step 1 ✓

**2. Placeholder 掃描：** 無

**3. 型別一致性：**
- `openingScaffold` 與 `openingMd` 在 Step 3–5 同一 function 內移除，無跨 task 型別依賴問題
- `today` 參數在步驟 5 改後不再用於 journal.md（但仍用於 `serializeNow(initialNow(today))`），保留不動
