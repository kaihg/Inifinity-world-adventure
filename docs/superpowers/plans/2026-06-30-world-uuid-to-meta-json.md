# world_uuid 移至 world/meta.json — 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `world_uuid` 從 `setting.md` 移至 `world/meta.json`，消除 UUID 進入 Layer 1 narrative prompt 的問題（Issue 9）。

**Architecture:** `world-id.ts` 移除 `injectWorldUuid`（注入 setting.md），新增 `writeWorldMeta`（寫 meta.json）；`readWorldUuid` 改讀 `meta.json`；`world-ops.ts` 的 `initWorld` 改呼叫 `writeWorldMeta`。`endWorld`、`protagonist-epitaph`、`archive` 等呼叫端透過 `readWorldUuid()` 介面取值，不需修改。

**Tech Stack:** TypeScript、Node.js、Vitest（`npm test` in `app/`）

## Global Constraints

- 不動 `endWorld`、`archive.ts`、`protagonist-epitaph.ts`、`player-meta.ts`、任何前端檔案
- `meta.json` 格式固定為 `{"worldUuid":"<uuid>"}\n`（單行 JSON 加結尾換行）
- `readWorldUuid` 對外介面不變（`(worldDir: string) => Promise<string>`），找不到時拋出錯誤
- Vitest 測試語法對齊 `app/src/engine/world-ops.test.ts` 現有慣例（describe/it/beforeEach）
- 繁體中文測試字串對齊現有慣例

---

## 檔案異動總覽

| 檔案 | 動作 |
|------|------|
| `app/src/engine/world-id.ts` | 修改：移除 `injectWorldUuid`；新增 `writeWorldMeta`；`readWorldUuid` 改讀 `meta.json` |
| `app/src/engine/world-ops.ts` | 修改：import 換 `writeWorldMeta`；`settingMdRaw` 重命名為 `settingMd`；刪 `injectWorldUuid` 呼叫行；step 5 加 `writeWorldMeta` |
| `app/src/engine/world-ops.test.ts` | 修改：更新 3 個 UUID 相關測試 |

---

## Task 1：移至 meta.json 並更新測試

**Files:**
- Modify: `app/src/engine/world-id.ts`
- Modify: `app/src/engine/world-ops.ts`
- Test: `app/src/engine/world-ops.test.ts`

**Interfaces:**
- Consumes: 無新介面，只重構現有函式
- Produces:
  - `writeWorldMeta(worldDir: string, worldUuid: string): Promise<void>` — 寫 `world/meta.json`
  - `readWorldUuid(worldDir: string): Promise<string>` — 介面不變，改讀 `meta.json`
  - `injectWorldUuid` — 移除（呼叫端 `world-ops.ts` 同步更新）

---

- [ ] **Step 1: 撰寫失敗測試（`world-ops.test.ts`）**

在 `app/src/engine/world-ops.test.ts` 做以下三處修改：

**1a. 在 line 6 的 import 增加 `writeWorldMeta`：**

```typescript
// 改前
import { readWorldUuid } from "./world-id.js";

// 改後
import { readWorldUuid, writeWorldMeta } from "./world-id.js";
```

**1b. 更新「initWorld 會把 world_uuid 寫進 setting.md」測試（約 line 192）：**

```typescript
// 改前
it("initWorld 會把 world_uuid 寫進 setting.md", async () => {
  const client: LlmClient = {
    async *streamChat(messages: ChatMessage[]) {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("設定設計師")) { yield "# 世界設定（World Setting）\n\n冷酷系統。\n"; return; }
      if (system.includes("角色設計師")) { yield "# 主角檔案\n\n沈奕。\n"; return; }
      yield "# 內容\n";
    },
  };

  await initWorld({ worldDir, repoRoot, client, input: {}, today: "2026-06-26", logger: createLogger() });
  const setting = await readFile(path.join(worldDir, "setting.md"), "utf8");
  expect(setting).toMatch(/世界 UUID[:：]\s*[a-f0-9-]{36}/i);
});

// 改後
it("initWorld 會把 world_uuid 寫進 meta.json，不寫進 setting.md", async () => {
  const client: LlmClient = {
    async *streamChat(messages: ChatMessage[]) {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      if (system.includes("設定設計師")) { yield "# 世界設定（World Setting）\n\n冷酷系統。\n"; return; }
      if (system.includes("角色設計師")) { yield "# 主角檔案\n\n沈奕。\n"; return; }
      yield "# 內容\n";
    },
  };

  await initWorld({ worldDir, repoRoot, client, input: {}, today: "2026-06-26", logger: createLogger() });

  const meta = JSON.parse(await readFile(path.join(worldDir, "meta.json"), "utf8")) as { worldUuid?: string };
  expect(meta.worldUuid).toMatch(/^[a-f0-9-]{36}$/);

  const setting = await readFile(path.join(worldDir, "setting.md"), "utf8");
  expect(setting).not.toMatch(/世界 UUID/);
});
```

**1c. 更新「readWorldUuid 從 setting.md 讀取並回傳 UUID」測試（約 line 248）：**

```typescript
// 改前
it("readWorldUuid 從 setting.md 讀取並回傳 UUID", async () => {
  await writeFile(path.join(worldDir, "setting.md"), "# 標題\n\n- 世界 UUID：550e8400-e29b-41d4-a716-446655440000\n", "utf8");
  const uuid = await readWorldUuid(worldDir);
  expect(uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
});

// 改後
it("readWorldUuid 從 meta.json 讀取並回傳 UUID", async () => {
  await writeWorldMeta(worldDir, "550e8400-e29b-41d4-a716-446655440000");
  const uuid = await readWorldUuid(worldDir);
  expect(uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
});
```

**1d. 更新「readWorldUuid 找不到 UUID 時拋出錯誤」測試（約 line 254）：**

```typescript
// 改前
it("readWorldUuid 找不到 UUID 時拋出錯誤", async () => {
  await writeFile(path.join(worldDir, "setting.md"), "# 標題\n\n無 UUID。\n", "utf8");
  await expect(readWorldUuid(worldDir)).rejects.toThrow();
});

// 改後
it("readWorldUuid 找不到 meta.json 時拋出錯誤", async () => {
  // worldDir 存在但無 meta.json — 不需額外寫檔
  await expect(readWorldUuid(worldDir)).rejects.toThrow();
});
```

---

- [ ] **Step 2: 跑測試確認新測試失敗**

```bash
cd app && npm test -- --reporter=verbose src/engine/world-ops.test.ts 2>&1 | grep -E "meta\.json|world_uuid|FAIL|PASS|Tests"
```

Expected：`initWorld 會把 world_uuid 寫進 meta.json` 和 `readWorldUuid 從 meta.json` 這兩個測試 **FAIL**（`writeWorldMeta` 尚未存在、`readWorldUuid` 尚未讀 `meta.json`）。

---

- [ ] **Step 3: 修改 `world-id.ts`**

完整取代 `app/src/engine/world-id.ts` 內容：

```typescript
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 產生新世界的 UUID（v4） */
export function generateWorldUuid(): string {
  return randomUUID();
}

/** 把 world_uuid 寫入 worldDir/meta.json */
export async function writeWorldMeta(worldDir: string, worldUuid: string): Promise<void> {
  await writeFile(
    path.join(worldDir, "meta.json"),
    JSON.stringify({ worldUuid }) + "\n",
    "utf8",
  );
}

/**
 * 從 worldDir/meta.json 讀取並回傳 world_uuid。
 * 若找不到則拋出錯誤。
 */
export async function readWorldUuid(worldDir: string): Promise<string> {
  const content = await readFile(path.join(worldDir, "meta.json"), "utf8");
  const parsed = JSON.parse(content) as { worldUuid?: string };
  if (!parsed.worldUuid) throw new Error("meta.json 中找不到 worldUuid");
  return parsed.worldUuid;
}
```

---

- [ ] **Step 4: 修改 `world-ops.ts`**

**4a. 更新 import（約 line 14）：**

```typescript
// 改前
import { generateWorldUuid, injectWorldUuid, readWorldUuid } from "./world-id.js";

// 改後
import { generateWorldUuid, writeWorldMeta, readWorldUuid } from "./world-id.js";
```

**4b. 重命名 `settingMdRaw` → `settingMd` 並移除 `injectWorldUuid` 呼叫（約 line 73–91）：**

```typescript
// 改前（約 line 73）
const settingMdRaw = await generateText(client, [
  { role: "system", content: "你是本世界的設定設計師。..." },
  { role: "user", content: [...].join("\n") },
]);
const settingMd = injectWorldUuid(settingMdRaw, worldUuid);

// 改後（移除 injectWorldUuid 那行，直接把 settingMdRaw 改名為 settingMd）
const settingMd = await generateText(client, [
  { role: "system", content: "你是本世界的設定設計師。..." },
  { role: "user", content: [...].join("\n") },
]);
// （不再有 injectWorldUuid 那行）
```

注意：`settingMd` 在後續 line 113（protagonist user content）、line 126（gmNotes user content）、line 132（writeFile）都已使用，重命名後這些行不需修改。

**4c. 更新 line 130 的注解：**

```typescript
// 改前
// settingMd 已由 injectWorldUuid 確保結尾換行，不再額外加 \n

// 改後
// settingMd 為 LLM 直接輸出，generateText 已 trim；writeFile 時不另加 \n
```

**4d. 在 step 5 寫入 `meta.json`（約 line 131，`mkdir` 之前）：**

```typescript
// 在這行之前插入：
await mkdir(path.join(worldDir, "characters"), { recursive: true });

// 插入：
await writeWorldMeta(worldDir, worldUuid);
```

最終 step 5 的完整寫入區塊（約 line 129–151）應如下：

```typescript
// 5) 全部寫入（最後才一次性落地，避免半初始化）
// settingMd 為 LLM 直接輸出，generateText 已 trim；writeFile 時不另加 \n
await mkdir(path.join(worldDir, "characters"), { recursive: true });
await writeWorldMeta(worldDir, worldUuid);
await writeFile(path.join(worldDir, "setting.md"), settingMd, "utf8");
await writeFile(path.join(worldDir, "gm-notes.md"), `${gmNotesMd}\n`, "utf8");
await writeFile(path.join(worldDir, "characters", "protagonist.md"), `${protagonistMd}\n`, "utf8");
await writeFile(
  path.join(worldDir, "characters", "index.md"),
  "# 角色索引（Character Index）\n\n| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |\n|----|------|------|----------|--------------|\n",
  "utf8",
);
await writeFile(
  path.join(worldDir, "journal.md"),
  `# 主空間日誌（Journal）\n`,
  "utf8",
);
await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");

const dungeonsDir = path.join(worldDir, "dungeons");
await rm(dungeonsDir, { recursive: true, force: true }).catch(() => {});
await mkdir(dungeonsDir, { recursive: true });
await writeFile(path.join(worldDir, ".pending-opening"), new Date().toISOString(), "utf8");
```

---

- [ ] **Step 5: 型別檢查**

```bash
cd app && npm run typecheck 2>&1 | head -20
```

Expected：無型別錯誤（`injectWorldUuid` 已從 import 和呼叫點完整移除）。

---

- [ ] **Step 6: 跑全套測試確認通過**

```bash
cd app && npm test 2>&1 | tail -20
```

Expected：全部 pass，包含三個更新後的 UUID 測試。

若有意外失敗：
- `readWorldUuid 找不到 meta.json 時拋出錯誤` 失敗 → 確認 worldDir 的 `beforeEach` 不預先建立 `meta.json`
- `endWorld` 測試中 `-unknown` 的 archive 路徑測試失敗 → 確認 `seedDirtyWorld` 未建立 `meta.json`（不需修改，自然 fallback 到 unknown）

---

- [ ] **Step 7: Commit**

```bash
git add app/src/engine/world-id.ts app/src/engine/world-ops.ts app/src/engine/world-ops.test.ts
git commit -m "feat: move world_uuid from setting.md to world/meta.json to avoid narrative contamination"
```

---

## Self-Review

**1. Spec 覆蓋：**
- `writeWorldMeta` 新增 → Step 3 ✓
- `readWorldUuid` 改讀 `meta.json` → Step 3 ✓
- `injectWorldUuid` 移除 → Step 3 ✓（從 world-id.ts 移除）+ Step 4a ✓（從 import 移除）+ Step 4b ✓（呼叫點移除）
- `initWorld` 改呼叫 `writeWorldMeta` → Step 4d ✓
- `setting.md` 不再含 UUID → Step 4b ✓（`settingMd` 為原始 LLM 輸出，不注入）
- 測試更新 → Step 1 ✓
- `endWorld`/`archive`/`protagonist-epitaph` 不動 → 符合 Global Constraints ✓

**2. Placeholder 掃描：** 無。

**3. 型別一致性：**
- `writeWorldMeta(worldDir: string, worldUuid: string): Promise<void>` 在 Step 3 定義，Step 4 使用
- `readWorldUuid(worldDir: string): Promise<string>` 介面不變
- `settingMdRaw` 重命名為 `settingMd` 後，後續 line 113/126/132 原本就用 `settingMd`，無需額外改動
