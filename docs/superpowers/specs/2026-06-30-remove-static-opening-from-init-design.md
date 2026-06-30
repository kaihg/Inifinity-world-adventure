# 移除 initWorld 靜態 Opening 生成

## 背景

`opening-turn-on-init`（2026-06-27）實作了開場回合的完整 pipeline：

1. `initWorld` 建立 `.pending-opening` sentinel
2. 前端 post-init 自動觸發 `streamTurn("")`
3. `runMainSpaceTurn` 偵測到 `.pending-opening` → 注入 `templates/opening.md` 作為特殊 system prompt
4. 開場敘事透過標準 turn pipeline 生成，寫入 `journal.md`，並呼叫 `appendJournalSummary`

但 `world-ops.ts` 的 `initWorld` 未被修改（計畫 Global Constraints 明確禁止），導致：

- `initWorld` 仍生成一段靜態 `openingMd`（一次額外 LLM call），用 `templates/opening.md`（已升格為 opening turn system prompt）當「寫作參考附錄」——語意錯誤
- `journal.md` 初始就含靜態 opening；opening turn 再 append 第二段 → **journal.md 有兩段 opening**
- `journal_summary.md` 缺少 opening 條目（Issue 6）
- 主角背景可能在靜態 opening 與後續回合間漂移（Issue 7）

## 設計

移除 `initWorld` 裡的靜態 opening 生成，讓開場敘事完全由已有的 opening turn pipeline 負責。

### 變更：`app/src/engine/world-ops.ts`

**步驟 1（template 讀取）**：移除 `openingScaffold`

```typescript
// 改前
const [settingScaffold, characterScaffold, openingScaffold] = await Promise.all([
  getTemplate("setting", worldDir, repoRoot),
  getTemplate("character", worldDir, repoRoot),
  getTemplate("opening", worldDir, repoRoot),
]);

// 改後
const [settingScaffold, characterScaffold] = await Promise.all([
  getTemplate("setting", worldDir, repoRoot),
  getTemplate("character", worldDir, repoRoot),
]);
```

**步驟 4（LLM 生成）**：移除 `openingMd`，`gmNotesMd` 從平行改為單一 `await`

```typescript
// 改前
const [gmNotesMd, openingMd] = await Promise.all([
  generateText(client, [...gm-notes prompt...]),
  generateText(client, [...opening prompt...]),
]);

// 改後
const gmNotesMd = await generateText(client, [...gm-notes prompt...]);
```

**步驟 5（寫檔）**：`journal.md` 只寫標題行

```typescript
// 改前
await writeFile(
  path.join(worldDir, "journal.md"),
  `# 主空間日誌（Journal）\n\n## [${today}] 新世界啟用\n\n${openingMd}\n`,
  "utf8",
);

// 改後
await writeFile(
  path.join(worldDir, "journal.md"),
  `# 主空間日誌（Journal）\n`,
  "utf8",
);
```

`.pending-opening` sentinel 的建立邏輯不動。

### 測試：`app/src/engine/world-ops.test.ts`

**移除**：`"journal.md 第一筆記錄是依 setting+protagonist 生成的開場敘事，不是制式文字"`
- 這個測試驗證靜態 opening 存在於 journal.md，正好是要消除的行為

**新增**：`"journal.md 初始只含標題行，不含任何 ## 回合段落"`

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

**既有測試不須改動**：
- `"initWorld 會把 world_uuid 寫進 setting.md"` — client 的 catch-all `yield "# 內容\n"` 處理 gm-notes，行為不變
- `"setting 先完成後，protagonist 才開始生成"` — 生成順序不變（setting → protagonist → gm-notes）
- `"initWorld 完成後 .pending-opening 存在（ISO timestamp）"` — sentinel 邏輯不動

## 影響

| | 改前 | 改後 |
|--|------|------|
| `initWorld` LLM call 數 | 4（setting + protagonist + gm-notes + opening） | 3（setting + protagonist + gm-notes） |
| `journal.md` 初始內容 | 標題 + 靜態 opening 敘事 | 僅標題行 |
| opening 敘事來源 | 靜態生成（initWorld）+ opening turn（重複） | 僅 opening turn（標準 pipeline） |
| Issue 6（journal_summary 缺 opening） | ❌ initWorld 未呼叫 appendJournalSummary | ✅ opening turn pipeline 已呼叫 |
| Issue 7（主角背景漂移） | ❌ 靜態 opening 與後續回合可能不一致 | ✅ 開場和後續回合都讀同一份 protagonist.md |

## 不在本次範圍

- Issue 9（UUID 汙染）：另立 spec
- `templates/opening.md` 內容：不動（已是 opening turn system prompt）
- `turn/index.ts` opening turn 邏輯：不動
- 前端 `sendOpening`：不動
