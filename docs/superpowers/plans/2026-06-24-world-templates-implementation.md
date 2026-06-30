# World Templates 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `templates/` 骨架目錄與 `world/templates/` 世界特定覆蓋機制，並把 `initWorld`、`dungeon.ts` 的 runs 結構改為 append-only `log.md`，以提升同一世界跨回合的劇情一致性。

**Architecture:**
全域骨架放在 repo 根目錄 `templates/`，Init 時讀骨架貼進 system prompt 讓 LLM 照結構填值。有「世界特定系統規則」的物件（item/skill/dungeon）在 init 時額外生成 `world/templates/<type>.md`；引擎查找 template 時先看 `world/templates/`，找不到退回 `templates/`（fallback）。副本 raw log 由多個 `runs/<id>.md` 改為單一 `dungeons/<id>/log.md`（append-only），對稱主空間 `journal.md`。

**Tech Stack:** Node.js, TypeScript, Vitest, fs/promises

## Global Constraints

- 所有測試用 Vitest（`cd app && npx vitest run`）
- 程式碼只使用 TypeScript，不加 `any`
- 函式輸出不可 mutate 傳入參數
- 骨架檔案是純 Markdown，無程式碼邏輯
- `world-ops.ts` 的 `initWorld` / `resetWorldToPlaceholder` 是本計畫改動最多的檔案

---

## 檔案對應

**新建：**
- `templates/setting.md` — 世界設定骨架（純 Markdown）
- `templates/protagonist.md` — 主角檔案骨架（純 Markdown）
- `templates/dungeon.md` — 副本骨架（純 Markdown，難度欄由世界填入）
- `templates/scene.md` — 場景骨架（純 Markdown）
- `templates/npc.md` — NPC 骨架（純 Markdown）
- `templates/item.md` — 道具骨架（純 Markdown，品質欄由世界填入）
- `templates/skill.md` — 技能骨架（純 Markdown，等級欄由世界填入）
- `app/src/engine/template-loader.ts` — `getTemplate(type, worldDir, repoRoot)` fallback 查找函式
- `app/src/engine/template-loader.test.ts` — 測試 fallback 邏輯

**修改：**
- `app/src/engine/world-ops.ts` — `initWorld` 讀骨架注入 prompt；新增生成 `world/templates/item.md`、`skill.md`、`dungeon.md`；`resetWorldToPlaceholder` 清除 `world/templates/`
- `app/src/engine/world-ops.test.ts` — 更新 `PLACEHOLDER_FILES`；補 template 相關測試
- `app/src/engine/dungeon.ts` — `enterDungeon` 改寫 `log.md`（不建 runs/）；`appendRun` 改 `appendLog`；`nextRunId` 改 `nextLogRunNumber`
- `app/src/engine/dungeon.test.ts` — 更新路徑斷言
- `app/src/engine/context.ts` — `loadLastTurn` 改讀 `dungeons/<id>/log.md`
- `app/src/engine/turn/index.ts` — `appendRaw` 改呼叫 `appendLog`；`rawFilePath` 改指向 `log.md`

---

## Task 1：建立全域骨架 Markdown 檔案

**Files:**
- Create: `templates/setting.md`
- Create: `templates/protagonist.md`
- Create: `templates/dungeon.md`
- Create: `templates/scene.md`
- Create: `templates/npc.md`
- Create: `templates/item.md`
- Create: `templates/skill.md`

**Interfaces:**
- Produces: 七份純 Markdown 骨架，供 Task 3 的 `initWorld` 讀取

- [ ] **Step 1: 建立 `templates/setting.md`**

```markdown
# 世界設定（World Setting）

<!-- 骨架：請在每個 ## 段落填入本世界的具體規則，段落標題不可改動 -->

## 主控系統
<!-- 主神/系統的表面樣貌、稱呼、與選民互動的方式 -->

## 世界基調
<!-- 整體風格：黑暗、輕鬆、寫實、奇幻等；影響敘事語氣 -->

## 副本機制
<!-- 副本是如何觸發、進入、結算的；系統公告格式 -->

## 難度等級系統
<!-- 本世界的副本難度分級（例如 F/E/D/C/B/A/S，或新手/普通/困難/噩夢） -->

## 道具品質系統
<!-- 本世界的道具品質/稀有度分級（例如 [普通/精良/史詩/傳說]，或 [白/綠/藍/紫/金]，或 A-Z） -->

## 技能等級系統
<!-- 本世界的技能等級與類型分類（例如 初級/中級/高級，或按屬性分類） -->

## 新手保護條款
<!-- 初期給予主角的特殊保護規則；幾個副本、什麼條件下失效 -->

## 主空間規則
<!-- 主神空間的基本法則：能做什麼、禁止什麼、積分如何使用 -->

## 當前篇章
<!-- 故事目前的篇章名稱與階段描述 -->

## 世界特定設定
<!-- 本世界獨有的額外規則，不在上述任何段落的都放這裡 -->
```

- [ ] **Step 2: 建立 `templates/protagonist.md`**

```markdown
# 主角檔案

<!-- 骨架：段落標題固定，內容由 init 填入 -->

## 基本資訊
<!-- 姓名、年齡、性別、外觀、背景 -->

## 當前積分
<!-- 數字；初始通常為 0 -->

## 屬性
<!-- 力量、敏捷、智力、感知等核心屬性與數值 -->

## 技能
<!-- 已習得的技能列表；初始通常為空 -->

## 物品欄
<!-- 持有道具；格式：道具名稱 [品質等級]（品質依 setting.md 定義） -->

## Buff / Debuff
<!-- 當前生效的增益與減益狀態 -->

## 新手保護備註
<!-- 當前保護條款的剩餘條件 -->
```

- [ ] **Step 3: 建立 `templates/dungeon.md`**

```markdown
# 副本：{{副本 ID}}

<!-- 骨架：段落標題固定，內容由進入副本時填入 -->

## 主題
<!-- 副本的世界觀背景，如三國、末日都市、賽博龐克、修仙界等 -->

## 難度
<!-- 依 setting.md 的難度等級系統填入；若對玩家隱藏則標記「[隱藏]」 -->

## 目標（表面）
<!-- 系統給予的公開任務描述 -->

## 場景概覽
<!-- 已揭露的主要場景列表與簡述 -->

## 已知 NPC
<!-- 與本副本相關的重要角色 -->

## 已知規則/機關
<!-- 已揭露的特殊規則或機關 -->

## 地圖（累積）
<!-- 逐步揭露的地圖結構 -->
```

- [ ] **Step 4: 建立 `templates/scene.md`**

```markdown
# 場景：{{場景名稱}}

<!-- 骨架：輕量，重點在固定視覺錨點防止前後矛盾 -->

## 外觀
<!-- 視覺描述，1-3 句；敘事中的視覺描述不可與此矛盾 -->

## 氛圍
<!-- 聲音、氣味、溫度、整體感受 -->

## 已知資訊
<!-- 確定事實：出口位置、固定 NPC、已知機關 -->

## 備註
<!-- 可選：特殊限制、隱藏線索（僅 GM 知）-->
```

- [ ] **Step 5: 建立 `templates/npc.md`**

```markdown
# NPC：{{姓名}}

<!-- 骨架：欄位跨世界通用 -->

## 基本資訊
<!-- 姓名、年齡、性別、外觀特徵 -->

## 性格
<!-- 主要性格特質，2-3 句 -->

## 動機
<!-- 明面上的目標；隱藏動機放 secrets.md -->

## 與主角的關係
<!-- 當前關係定位：友善/中立/敵對；具體互動歷史 -->

## 已知能力
<!-- 觀察到的技能或戰力評估 -->

## 最近狀態
<!-- 最後出場時的狀況（由劇情更新） -->
```

- [ ] **Step 6: 建立 `templates/item.md`**

```markdown
# 道具：{{道具名稱}}

<!-- 骨架：品質欄依 world/templates/item.md（或 setting.md）定義 -->

## 品質等級
<!-- 依本世界品質系統填入（如 [普通]、[史詩]、B 級） -->

## 外觀描述
<!-- 道具的物理外觀，1-2 句 -->

## 效果/說明
<!-- 使用後的效果或道具用途 -->

## 特殊特性
<!-- 可選：被動效果、限制、附魔、傳說背景等 -->

## 取得方式
<!-- 怎麼得到的；副本掉落/兌換/製作等 -->
```

- [ ] **Step 7: 建立 `templates/skill.md`**

```markdown
# 技能：{{技能名稱}}

<!-- 骨架：等級/類型欄依 world/templates/skill.md（或 setting.md）定義 -->

## 等級 / 類型
<!-- 依本世界技能系統填入（如 初級、被動型、火系 A 級） -->

## 效果描述
<!-- 技能的具體效果，包含數值範圍（若有） -->

## 消耗
<!-- 使用技能的積分/體力/冷卻消耗 -->

## 習得條件
<!-- 如何習得；兌換積分、副本獎勵、自動解鎖等 -->

## 備註
<!-- 可選：升級路徑、組合效果、使用限制 -->
```

- [ ] **Step 8: Commit**

```bash
git add templates/
git commit -m "feat(templates): 建立全域骨架 Markdown 檔案（setting/protagonist/dungeon/scene/npc/item/skill）"
```

---

## Task 2：實作 `template-loader.ts`（Fallback 查找）

**Files:**
- Create: `app/src/engine/template-loader.ts`
- Create: `app/src/engine/template-loader.test.ts`

**Interfaces:**
- Produces: `getTemplate(type: string, worldDir: string, repoRoot: string): Promise<string>` — 回傳骨架內容字串；優先讀 `world/templates/<type>.md`，缺檔退回 `templates/<type>.md`

- [ ] **Step 1: 寫失敗測試**

```typescript
// app/src/engine/template-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTemplate } from "./template-loader.js";

describe("getTemplate", () => {
  let tmpRoot: string;
  let worldDir: string;
  let repoRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "iwa-tpl-"));
    repoRoot = tmpRoot;
    worldDir = path.join(tmpRoot, "world");
    await mkdir(path.join(worldDir, "templates"), { recursive: true });
    await mkdir(path.join(tmpRoot, "templates"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("world/templates/<type>.md 存在時回傳世界特定骨架", async () => {
    await writeFile(
      path.join(worldDir, "templates", "item.md"),
      "# 世界特定 item 骨架",
      "utf8",
    );
    await writeFile(
      path.join(tmpRoot, "templates", "item.md"),
      "# 全域 item 骨架",
      "utf8",
    );
    const result = await getTemplate("item", worldDir, repoRoot);
    expect(result).toBe("# 世界特定 item 骨架");
  });

  it("world/templates/<type>.md 不存在時退回全域 templates/", async () => {
    await writeFile(
      path.join(tmpRoot, "templates", "npc.md"),
      "# 全域 npc 骨架",
      "utf8",
    );
    const result = await getTemplate("npc", worldDir, repoRoot);
    expect(result).toBe("# 全域 npc 骨架");
  });

  it("兩份都不存在時拋出 Error", async () => {
    await expect(getTemplate("nonexistent", worldDir, repoRoot)).rejects.toThrow(
      "找不到 nonexistent 的 template",
    );
  });
});
```

- [ ] **Step 2: 執行確認失敗**

```bash
cd app && npx vitest run src/engine/template-loader.test.ts
```

Expected: FAIL（`template-loader.ts` 尚不存在）

- [ ] **Step 3: 實作 `template-loader.ts`**

```typescript
// app/src/engine/template-loader.ts
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 查找指定類型的 template 骨架。
 * 優先讀 world/templates/<type>.md（世界特定），
 * 缺檔退回 templates/<type>.md（全域骨架）。
 * 兩份都不存在則拋出 Error。
 */
export async function getTemplate(
  type: string,
  worldDir: string,
  repoRoot: string,
): Promise<string> {
  const worldSpecific = path.join(worldDir, "templates", `${type}.md`);
  const global = path.join(repoRoot, "templates", `${type}.md`);

  for (const file of [worldSpecific, global]) {
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`找不到 ${type} 的 template：已尋找 ${worldSpecific} 與 ${global}`);
}
```

- [ ] **Step 4: 執行確認通過**

```bash
cd app && npx vitest run src/engine/template-loader.test.ts
```

Expected: PASS（3 個測試）

- [ ] **Step 5: Commit**

```bash
git add app/src/engine/template-loader.ts app/src/engine/template-loader.test.ts
git commit -m "feat(engine): 新增 template-loader（world/templates/ fallback 查找）"
```

---

## Task 3：修改 `initWorld` 使用骨架 + 生成世界特定 templates

**Files:**
- Modify: `app/src/engine/world-ops.ts`
- Modify: `app/src/engine/world-ops.test.ts`

**Interfaces:**
- Consumes: `getTemplate(type, worldDir, repoRoot)` from `template-loader.ts`
- `initWorld` 新增必填參數 `repoRoot: string`（用來找全域 templates/）
- Produces: init 後 `world/templates/item.md`、`world/templates/skill.md`、`world/templates/dungeon.md` 存在

注意：`initWorld` 目前的型別簽名只有 `worldDir`，需要加 `repoRoot`。`app/src/server/app.ts:51` 已有 `const repoRoot = path.dirname(config.worldDir)`，可直接傳入。

- [ ] **Step 1: 讀現有 `initWorld` 與 test 確認基線**

```bash
cd app && npx vitest run src/engine/world-ops.test.ts
```

Expected: PASS（所有既有測試通過）

- [ ] **Step 2: 修改 `world-ops.ts` — `initWorld` 加 `repoRoot` 與骨架注入**

在 `app/src/engine/world-ops.ts` 頂部新增 import：

```typescript
import { getTemplate } from "./template-loader.js";
import { mkdir as mkdirFs } from "node:fs/promises";
```

修改 `initWorld` 函式簽名（`opts` 加 `repoRoot`）：

```typescript
export async function initWorld(opts: {
  worldDir: string;
  repoRoot: string;
  client: LlmClient;
  input: WorldInitInput;
  today: string;
  logger: Logger;
}): Promise<void> {
  const { worldDir, repoRoot, client, input, today } = opts;
  const pref = input.preferences ?? {};

  // 1) 讀骨架
  const settingScaffold = await getTemplate("setting", worldDir, repoRoot);

  // 2) setting.md（玩家可見）— 骨架貼進 prompt
  const settingMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的設定設計師。依玩家偏好，照以下骨架結構填入此世界的具體規則（繁體中文）。" +
        "段落標題（## 開頭）不可改動，每段自由發揮，但必須在本世界全程一致。" +
        "只輸出 markdown 正文，開頭是 `# 世界設定（World Setting）`。\n\n" +
        "骨架如下：\n\n" + settingScaffold,
    },
    {
      role: "user",
      content: [
        `難度：${pref.difficulty?.trim() || UNSPEC}`,
        `主神表面性格：${pref.godPersona?.trim() || UNSPEC}`,
        `新手保護規則草案：${pref.protectionRule?.trim() || UNSPEC}`,
      ].join("\n"),
    },
  ]);

  // 3) gm-notes.md — 不變
  const gmNotesMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的暗線設計師。依玩家可見的 setting.md，自主編寫世界隱藏真相 gm-notes.md（繁體中文）：" +
        "主神真實動機、世界背後真相、最終目的、暗線伏筆。這是劇透文件，玩家永遠不會直接看到。" +
        "只輸出 markdown 正文，開頭是 `# 世界隱藏真相（GM Notes）`。",
    },
    { role: "user", content: `玩家可見設定如下：\n\n${settingMd}` },
  ]);

  // 4) protagonist.md — 讀骨架
  const protagonistScaffold = await getTemplate("protagonist", worldDir, repoRoot);
  const protagonistMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的角色設計師。照以下骨架結構，填入主角初始資料（繁體中文）。" +
        "段落標題不可改動。只輸出 markdown 正文，開頭是 `# 主角檔案`。\n\n" +
        "骨架如下：\n\n" + protagonistScaffold,
    },
    { role: "user", content: buildProtagonistPrompt(input.protagonistSeed ?? {}) },
  ]);

  // 5) 世界特定 templates（item/skill/dungeon）— 依 setting 生成
  const [itemTemplateMd, skillTemplateMd, dungeonTemplateMd] = await Promise.all([
    generateText(client, [
      {
        role: "system",
        content:
          "依以下世界設定，生成本世界的道具骨架（繁體中文）。" +
          "複製全域骨架結構，但在「## 品質等級」段加上本世界的品質系統定義（例如：本世界品質分 [普通/精良/史詩/傳說] 四級）。" +
          "骨架段落標題不可改，只輸出 markdown，開頭是 `# 道具：{{道具名稱}}`。",
      },
      { role: "user", content: `世界設定：\n\n${settingMd}` },
    ]),
    generateText(client, [
      {
        role: "system",
        content:
          "依以下世界設定，生成本世界的技能骨架（繁體中文）。" +
          "複製全域骨架結構，但在「## 等級 / 類型」段加上本世界的技能系統定義。" +
          "骨架段落標題不可改，只輸出 markdown，開頭是 `# 技能：{{技能名稱}}`。",
      },
      { role: "user", content: `世界設定：\n\n${settingMd}` },
    ]),
    generateText(client, [
      {
        role: "system",
        content:
          "依以下世界設定，生成本世界的副本骨架（繁體中文）。" +
          "複製全域骨架結構，但在「## 難度」段加上本世界的難度等級定義。" +
          "骨架段落標題不可改，只輸出 markdown，開頭是 `# 副本：{{副本 ID}}`。",
      },
      { role: "user", content: `世界設定：\n\n${settingMd}` },
    ]),
  ]);

  // 6) 全部寫入（最後才一次性落地）
  await mkdir(path.join(worldDir, "characters"), { recursive: true });
  await mkdir(path.join(worldDir, "templates"), { recursive: true });
  await writeFile(path.join(worldDir, "setting.md"), `${settingMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "gm-notes.md"), `${gmNotesMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "characters", "protagonist.md"), `${protagonistMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "templates", "item.md"), `${itemTemplateMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "templates", "skill.md"), `${skillTemplateMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "templates", "dungeon.md"), `${dungeonTemplateMd}\n`, "utf8");
  await writeFile(
    path.join(worldDir, "characters", "index.md"),
    [
      "# 角色索引（Character Index）",
      "",
      "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
      "|----|------|------|----------|--------------|",
      "| protagonist | 主角 | 主角 | 新世界開局 | - |",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "journal.md"),
    `# 主空間日誌（Journal）\n\n## [${today}] 新世界啟用\n\n新世界建立，主角剛被系統選中。\n`,
    "utf8",
  );
  await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");

  const dungeonsDir = path.join(worldDir, "dungeons");
  await rm(dungeonsDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dungeonsDir, { recursive: true });
}
```

- [ ] **Step 3: 修改 `resetWorldToPlaceholder` 清除 `world/templates/`**

在 `resetWorldToPlaceholder` 函式中（`rm(worldDir, ...)` 之後，`mkdir` 之前），確認整個 worldDir 已被清空後補建 `world/templates/`：

```typescript
// resetWorldToPlaceholder 中，mkdir 那行之後加：
await mkdir(path.join(worldDir, "templates"), { recursive: true });
```

（因為整個 `worldDir` 已被 `rm` 清空，只需在重建時順帶建 `templates/` 目錄即可。不需要額外清除。）

- [ ] **Step 4: 修改 `app/src/server/app.ts` 傳入 `repoRoot`**

在 `app.ts` 呼叫 `initWorld` 的地方（第 178 行附近）補上 `repoRoot`：

```typescript
await initWorld({
  worldDir: config.worldDir,
  repoRoot,                   // 新增這行
  client: makeClient(opLogger),
  input: body,
  today: todayISO(),
  logger: opLogger,
});
```

- [ ] **Step 5: 更新測試**

在 `world-ops.test.ts` 更新 `PLACEHOLDER_FILES`（`resetWorldToPlaceholder` 後應有 `templates/` 目錄，但目錄本身不會出現在 `listFiles` 結果中，所以此清單不變）。

補一個 `initWorld` 骨架測試（使用 fake client 和 fake templates）：

```typescript
describe("initWorld 骨架注入", () => {
  let repoRoot: string;
  let worldDir: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-init-"));
    worldDir = path.join(repoRoot, "world");
    await mkdir(worldDir, { recursive: true });
    // 建全域骨架（最小版）
    await mkdir(path.join(repoRoot, "templates"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "templates", "setting.md"),
      "# 世界設定（World Setting）\n\n## 主控系統\n<!-- 填入 -->\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "templates", "protagonist.md"),
      "# 主角檔案\n\n## 基本資訊\n<!-- 填入 -->\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("init 後 world/templates/ 含三份世界特定骨架", async () => {
    await initWorld({
      worldDir,
      repoRoot,
      client: fakeClient,
      input: {},
      today: "2026-06-24",
      logger: createLogger(),
    });

    const tplFiles = await readdir(path.join(worldDir, "templates"));
    expect(tplFiles.sort()).toEqual(["dungeon.md", "item.md", "skill.md"]);
  });
});
```

- [ ] **Step 6: 執行測試確認通過**

```bash
cd app && npx vitest run src/engine/world-ops.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/src/engine/world-ops.ts app/src/engine/world-ops.test.ts app/src/server/app.ts
git commit -m "feat(engine): initWorld 讀骨架注入 prompt，生成 world/templates/（item/skill/dungeon）"
```

---

## Task 4：副本 `runs/` 改為 append-only `log.md`

**Files:**
- Modify: `app/src/engine/dungeon.ts`
- Modify: `app/src/engine/dungeon.test.ts`
- Modify: `app/src/engine/context.ts`（`loadLastTurn`）
- Modify: `app/src/engine/turn/index.ts`（`appendRaw`、`rawFilePath`）

**Interfaces:**
- Consumes: `ActiveDungeon { dungeonId, runId }` — `runId` 語意改為「本次進入的流水序號」，儲存在 `log.md` 的段落標題中，不再對應到實際檔案路徑
- Produces:
  - `enterDungeon(...)` → 寫 `dungeons/<id>/log.md` 的新段落，回傳 `ActiveDungeon`
  - `appendLog(worldDir, dungeonId, runId, entry)` — 取代 `appendRun`
  - `log.md` 格式：每次進入是一個 `## run-N（進入時間）` 段落，之後的 append 都在此段落下

- [ ] **Step 1: 確認現有測試基線**

```bash
cd app && npx vitest run src/engine/dungeon.test.ts src/engine/context.test.ts
```

Expected: PASS

- [ ] **Step 2: 修改 `dungeon.ts` — `enterDungeon` 改寫 `log.md`**

移除 `nextRunId`、`runs/` 相關邏輯，改為讀 `log.md` 計算下一個 run 序號：

```typescript
/** 從 log.md 內容推下一個 run 序號（## run-1…run-N 的最大值 +1） */
export function nextRunNumber(logContent: string): number {
  const matches = [...logContent.matchAll(/^## run-(\d+)/gm)];
  const nums = matches.map((m) => Number(m[1]));
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

export async function enterDungeon(
  worldDir: string,
  params: EnterDungeonParams,
  logger: Logger = defaultLogger,
): Promise<ActiveDungeon> {
  const dir = dungeonDir(worldDir, params.dungeonId);
  await mkdir(dir, { recursive: true });

  const logFile = path.join(dir, "log.md");
  let existing = "";
  try {
    existing = await readFile(logFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }

  const runNumber = nextRunNumber(existing);
  const runId = `run-${runNumber}`;
  logger.info({ dungeonId: params.dungeonId, runId }, "進入副本");

  const header = [
    `## ${runId}（${params.today}）`,
    "",
    `- 進入時角色狀態：${toTraditional(params.protagonistSummary)}`,
    `- 本次目標：${toTraditional(params.goal)}`,
    "",
    "---",
    "",
  ].join("\n");

  if (!existing.trim()) {
    // 首次進入，建立檔案含 h1 標題
    await writeFile(
      logFile,
      `# 副本 ${params.dungeonId} · Log\n\n${header}`,
      "utf8",
    );
  } else {
    await appendFile(logFile, `\n${header}`);
  }

  await ensureSecrets(worldDir, "dungeons", params.dungeonId, params.secretsText, `副本隱藏真相（${params.dungeonId}）`, logger);

  return { dungeonId: params.dungeonId, runId };
}
```

移除 `nextRunId` export（不再需要），新增 `appendLog`（取代 `appendRun`）：

```typescript
/** 把回合記錄 append 到 dungeons/<id>/log.md（副本 raw 層，append-only） */
export async function appendLog(
  worldDir: string,
  dungeonId: string,
  runId: string,
  entry: RunEntry,
): Promise<void> {
  const file = path.join(dungeonDir(worldDir, dungeonId), "log.md");
  await appendFile(file, `\n### [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`, "utf8");
}
```

保留 `appendRun` 名稱的 export 以免大量改名，改為別名：

```typescript
/** @deprecated 請改用 appendLog */
export const appendRun = appendLog;
```

- [ ] **Step 3: 修改 `context.ts` — `loadLastTurn` 改讀 `log.md`**

找到 `loadLastTurn` 函式（約第 262 行），改 `runs/<runId>.md` → `log.md`：

```typescript
async function loadLastTurn(worldDir: string, now: NowState, logger: Logger): Promise<LastTurnRecord | null> {
  const active = parseActiveDungeon(now.activeDungeon);
  const rawFile = active
    ? path.join(worldDir, "dungeons", active.dungeonId, "log.md")
    : path.join(worldDir, "journal.md");
  const md = await readOrEmpty(rawFile, logger);
  return md ? parseLastTurnRecord(md) : null;
}
```

- [ ] **Step 4: 修改 `turn/index.ts` — `rawFilePath` 改指向 `log.md`**

在 `runDungeonTurn` 中，找到 `plan.rawFilePath` 和 `plan.appendRaw` 的設定：

```typescript
appendRaw: (entry) => appendLog(deps.worldDir, active.dungeonId, active.runId, entry),
rawFilePath: path.join(deps.worldDir, "dungeons", active.dungeonId, "log.md"),
```

同時更新 import：在 `turn/index.ts` 頂部改 `appendRun` → `appendLog`（若 `appendRun` 已是別名則不影響，但建議明確用新名稱）。

- [ ] **Step 5: 更新 `dungeon.test.ts`**

移除 `nextRunId` 測試，新增 `nextRunNumber` 測試；更新路徑斷言從 `runs/run-1.md` → `log.md`：

```typescript
describe("nextRunNumber", () => {
  it("空 log → 1", () => {
    expect(nextRunNumber("")).toBe(1);
  });
  it("已有 run-1、run-2 → 3", () => {
    const content = "## run-1（2026-06-24）\n\n內容\n\n## run-2（2026-06-25）\n\n內容";
    expect(nextRunNumber(content)).toBe(3);
  });
  it("有 run-1、run-4 → 5（取最大值）", () => {
    const content = "## run-1（2026-06-24）\n\n內容\n\n## run-4（2026-06-28）\n\n內容";
    expect(nextRunNumber(content)).toBe(5);
  });
});

// 更新 enterDungeon 測試，確認 log.md 存在而非 runs/run-1.md
it("首次進入建 log.md 與 secrets，回傳 run-1", async () => {
  const active = await enterDungeon(world, {
    dungeonId: "U-001",
    today: "2026-06-19",
    protagonistSummary: "沈奕（積分 0）",
    goal: "找到出口",
    secretsText: "真正的機關：地板會塌。",
  });
  expect(active).toEqual({ dungeonId: "U-001", runId: "run-1" });

  const log = await readFile(path.join(world, "dungeons", "U-001", "log.md"), "utf8");
  expect(log).toContain("run-1");
  expect(log).toContain("2026-06-19");
  expect(log).toContain("沈奕");

  // runs/ 目錄不應建立
  await expect(readdir(path.join(world, "dungeons", "U-001", "runs"))).rejects.toThrow();
});

it("第二次進入同一副本 → run-2", async () => {
  await enterDungeon(world, {
    dungeonId: "U-001",
    today: "2026-06-20",
    protagonistSummary: "沈奕（積分 50）",
    goal: "找到隱藏出口",
    secretsText: "真正的機關：地板會塌。",
  });
  const active = await enterDungeon(world, {
    dungeonId: "U-001",
    today: "2026-06-21",
    protagonistSummary: "沈奕（積分 80）",
    goal: "終結副本",
    secretsText: "（已存在，不覆寫）",
  });
  expect(active.runId).toBe("run-2");
  const log = await readFile(path.join(world, "dungeons", "U-001", "log.md"), "utf8");
  expect(log).toContain("run-2");
});
```

- [ ] **Step 6: 執行所有相關測試**

```bash
cd app && npx vitest run src/engine/dungeon.test.ts src/engine/context.test.ts src/engine/turn/index.test.ts
```

Expected: PASS

- [ ] **Step 7: 執行全部測試確認無回歸**

```bash
cd app && npx vitest run
```

Expected: PASS（所有測試）

- [ ] **Step 8: Commit**

```bash
git add app/src/engine/dungeon.ts app/src/engine/dungeon.test.ts \
        app/src/engine/context.ts app/src/engine/turn/index.ts
git commit -m "feat(engine): 副本 runs/*.md 改為單一 append-only log.md（對稱 journal.md）"
```

---

## Task 5：更新 `world-ops.ts` — `resetWorldToPlaceholder` 與 `seedDirtyWorld` 對齊

**Files:**
- Modify: `app/src/engine/world-ops.test.ts` — `seedDirtyWorld` 把 `runs/run-1.md` 改為 `log.md`

**Interfaces:**
- 無新介面，只是讓測試輔助函式與新的 `log.md` 結構對齊

- [ ] **Step 1: 更新 `seedDirtyWorld`**

在 `world-ops.test.ts` 找到 `seedDirtyWorld` 函式，把：
```typescript
await mkdir(path.join(worldDir, "dungeons", "new_dungeon", "runs"), { recursive: true });
// ...
await writeFile(path.join(worldDir, "dungeons", "new_dungeon", "runs", "run-1.md"), "run\n", "utf8");
```
改為：
```typescript
await mkdir(path.join(worldDir, "dungeons", "new_dungeon"), { recursive: true });
// ...
await writeFile(path.join(worldDir, "dungeons", "new_dungeon", "log.md"), "# 副本 new_dungeon · Log\n\n## run-1（2026-06-24）\n\nrun\n", "utf8");
```

- [ ] **Step 2: 執行測試確認通過**

```bash
cd app && npx vitest run src/engine/world-ops.test.ts
```

Expected: PASS

- [ ] **Step 3: 執行全部測試**

```bash
cd app && npx vitest run
```

Expected: PASS（所有測試）

- [ ] **Step 4: Commit**

```bash
git add app/src/engine/world-ops.test.ts
git commit -m "test(engine): 更新 seedDirtyWorld 對齊 log.md 結構"
```

---

## 自審 Checklist

**Spec 覆蓋：**
- [x] 全域骨架 templates/ — Task 1
- [x] initWorld 讀骨架注入 prompt — Task 3
- [x] init 時生成 world/templates/item.md、skill.md、dungeon.md — Task 3
- [x] template fallback 查找函式 — Task 2
- [x] resetWorldToPlaceholder 清除 world/templates/ — Task 3
- [x] runs/ 改 log.md — Task 4
- [x] loadLastTurn 改讀 log.md — Task 4

**Placeholder 掃描：** 無 TBD/TODO

**型別一致性：**
- `nextRunId` → `nextRunNumber`（Task 4 移除舊 export）
- `appendRun` 保留為 `appendLog` 的別名，`turn/index.ts` 建議明確改用 `appendLog`
- `initWorld` opts 新增 `repoRoot: string`，呼叫端 `app.ts` 已有此值
