import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetWorldToPlaceholder, endWorld, initWorld, replaceProtagonist } from "./world-ops.js";
import { readWorldUuid } from "./world-id.js";
import { isWorldInitialized } from "./world-status.js";
import { createLogger } from "../logger.js";
import type { LlmClient, ChatMessage } from "../llm/client.js";

/** 建立一個可手動控制何時 resolve 的 promise，供「卡住的 fake client」測試使用 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 輪詢直到條件成立或逾時；用於驗證非同步呼叫是否「真的」並行啟動，避免固定 setTimeout 造成時序抖動 */
async function waitUntil(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil 逾時（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 遞迴列出 worldDir 底下所有檔案的相對路徑（不含目錄本身） */
async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

/** 固定回傳一段摘要的假 LLM client，不打任何網路 */
const fakeClient: LlmClient = {
  // eslint-disable-next-line require-yield
  async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
    yield "這是一段測試用的終章摘要。";
  },
};

const PLACEHOLDER_FILES = [
  "characters/index.md",
  "characters/protagonist.md",
  "gm-notes.md",
  "journal.md",
  "now.md",
  "setting.md",
].sort();

/** 在 worldDir 鋪一個「玩過、長出一堆動態檔案」的髒世界 */
async function seedDirtyWorld(worldDir: string): Promise<void> {
  await mkdir(path.join(worldDir, "characters"), { recursive: true });
  await mkdir(path.join(worldDir, "scenes", "iron_gate"), { recursive: true });
  await mkdir(path.join(worldDir, "items", "metal_club"), { recursive: true });
  await mkdir(path.join(worldDir, "dungeons", "new_dungeon"), { recursive: true });
  await writeFile(path.join(worldDir, "setting.md"), "# 世界設定（World Setting）\n\n舊世界。\n", "utf8");
  await writeFile(path.join(worldDir, "gm-notes.md"), "# 世界隱藏真相（GM Notes）\n\n舊真相。\n", "utf8");
  await writeFile(path.join(worldDir, "now.md"), "- 當前篇章：第一章\n", "utf8");
  await writeFile(path.join(worldDir, "journal.md"), "# 主空間日誌（Journal）\n\n舊日誌。\n", "utf8");
  await writeFile(path.join(worldDir, "journal_summary.md"), "# 摘要\n\n舊摘要。\n", "utf8");
  await writeFile(path.join(worldDir, "characters", "protagonist.md"), "# 主角檔案\n\n沈奕。\n", "utf8");
  await writeFile(path.join(worldDir, "characters", "index.md"), "| ID | 姓名 |\n", "utf8");
  await writeFile(path.join(worldDir, "characters", "chenzhe.md"), "# NPC：陳哲\n", "utf8");
  await writeFile(path.join(worldDir, "characters", "linsiyu.md"), "# NPC：林思雨\n", "utf8");
  await writeFile(path.join(worldDir, "scenes", "iron_gate", "wiki.md"), "# 鐵門\n", "utf8");
  await writeFile(path.join(worldDir, "items", "metal_club", "wiki.md"), "# 鐵棍\n", "utf8");
  await writeFile(path.join(worldDir, "dungeons", "new_dungeon", "log.md"), "# 副本 new_dungeon · Log\n\n## run-1（2026-06-24）\n\nrun\n", "utf8");
}

describe("resetWorldToPlaceholder", () => {
  let worldDir: string;
  beforeEach(async () => {
    worldDir = await mkdtemp(path.join(tmpdir(), "iwa-reset-"));
  });
  afterEach(async () => {
    await rm(worldDir, { recursive: true, force: true });
  });

  it("清掉所有動態長出的殘留（NPC/scenes/items/journal_summary），只留佔位檔", async () => {
    await seedDirtyWorld(worldDir);
    await resetWorldToPlaceholder(worldDir, "2026-06-24");

    const files = await listFiles(worldDir);
    expect(files).toEqual(PLACEHOLDER_FILES);
    // 重置後世界被視為「未初始化」
    expect(await isWorldInitialized(worldDir)).toBe(false);
  });

  it("dungeons/ 被清空（保留空目錄）", async () => {
    await seedDirtyWorld(worldDir);
    await resetWorldToPlaceholder(worldDir, "2026-06-24");
    const dungeons = await readdir(path.join(worldDir, "dungeons"));
    expect(dungeons).toEqual([]);
  });
});

describe("endWorld", () => {
  let repoRoot: string;
  let worldDir: string;
  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-endworld-"));
    worldDir = path.join(repoRoot, "world");
    await mkdir(worldDir, { recursive: true });
  });
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("完整封存舊世界（含動態殘留）到 archives/，且封存後 world/ 不留任何舊檔", async () => {
    await seedDirtyWorld(worldDir);

    const archivedTo = await endWorld({
      repoRoot,
      worldDir,
      client: fakeClient,
      today: "2026-06-24",
      logger: createLogger(),
    });

    // 1) archive 完整保留舊世界（含 scenes/items/NPC）
    const archivedFiles = await listFiles(path.join(repoRoot, archivedTo, "world"));
    expect(archivedFiles).toContain("scenes/iron_gate/wiki.md");
    expect(archivedFiles).toContain("items/metal_club/wiki.md");
    expect(archivedFiles).toContain("characters/chenzhe.md");
    expect(archivedFiles).toContain("journal_summary.md");
    // summary.md 與 world/ 同層
    const summary = await readFile(path.join(repoRoot, archivedTo, "summary.md"), "utf8");
    expect(summary).toContain("終章摘要");

    // 2) 封存後 world/ 只剩佔位檔，零殘留
    const remaining = await listFiles(worldDir);
    expect(remaining).toEqual(PLACEHOLDER_FILES);
    expect(await isWorldInitialized(worldDir)).toBe(false);

    // 3) setting.md 無 UUID，封存路徑應以 -unknown 結尾
    expect(archivedTo).toMatch(/-unknown$/);
  });
});

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
      path.join(repoRoot, "templates", "character.md"),
      "# 角色檔案：{{姓名}}\n\n## 基本資訊\n<!-- 填入 -->\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "templates", "opening.md"),
      "# 開場敘事\n\n## 必須涵蓋\n<!-- 填入 -->\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "templates", "item.md"),
      "# 道具：{{道具名稱}}\n\n## 品質等級\n<!-- 填入 -->\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "templates", "skill.md"),
      "# 技能：{{技能名稱}}\n\n## 等級 / 類型\n<!-- 填入 -->\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "templates", "dungeon.md"),
      "# 副本：{{副本名稱}}\n\n## 難度\n<!-- 填入 -->\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("initWorld 會把 world_uuid 寫進 setting.md", async () => {
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("設定設計師")) {
          yield "# 世界設定（World Setting）\n\n冷酷系統。\n";
          return;
        }
        if (system.includes("角色設計師")) {
          yield "# 主角檔案\n\n沈奕。\n";
          return;
        }
        yield "# 內容\n";
      },
    };

    await initWorld({ worldDir, repoRoot, client, input: {}, today: "2026-06-26", logger: createLogger() });
    const setting = await readFile(path.join(worldDir, "setting.md"), "utf8");
    expect(setting).toMatch(/世界 UUID[:：]\s*[a-f0-9-]{36}/i);
  });

  it("setting 先完成後，protagonist 才開始生成（character 需要 settingMd 定義屬性系統）", async () => {
    const order: string[] = [];
    const settingDeferred = createDeferred<void>();
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("設定設計師")) {
          order.push("setting-start");
          await settingDeferred.promise;
          order.push("setting-end");
          yield "# 世界設定\n\n冷酷系統。\n";
          return;
        }
        if (system.includes("角色設計師")) {
          order.push("character-start");
          yield "# 主角檔案\n\n沈奕。\n";
          return;
        }
        yield "# 內容\n";
      },
    };

    const initPromise = initWorld({ worldDir, repoRoot, client, input: {}, today: "2026-06-24", logger: createLogger() });
    await waitUntil(() => order.includes("setting-start"));
    // setting 尚未完成，character 不應該已啟動
    expect(order).not.toContain("character-start");

    settingDeferred.resolve();
    await waitUntil(() => order.includes("character-start"));
    // setting 完成後，character 才啟動
    expect(order.indexOf("setting-end")).toBeLessThan(order.indexOf("character-start"));

    await initPromise;
  });

  it("readWorldUuid 從 setting.md 讀取並回傳 UUID", async () => {
    await writeFile(path.join(worldDir, "setting.md"), "# 標題\n\n- 世界 UUID：550e8400-e29b-41d4-a716-446655440000\n", "utf8");
    const uuid = await readWorldUuid(worldDir);
    expect(uuid).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("readWorldUuid 找不到 UUID 時拋出錯誤", async () => {
    await writeFile(path.join(worldDir, "setting.md"), "# 標題\n\n無 UUID。\n", "utf8");
    await expect(readWorldUuid(worldDir)).rejects.toThrow();
  });

  it("journal.md 第一筆記錄是依 setting+protagonist 生成的開場敘事，不是制式文字", async () => {
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("設定設計師")) {
          yield "# 世界設定\n\n冷酷系統。\n";
          return;
        }
        if (system.includes("角色設計師")) {
          yield "# 主角檔案\n\n沈奕，前消防員。\n";
          return;
        }
        if (system.includes("開場敘事")) {
          // user content 帶 settingMd/protagonistMd，藉此驗證兩者都已生成完成才呼叫
          const user = messages.find((m) => m.role === "user")?.content ?? "";
          expect(user).toContain("冷酷系統");
          expect(user).toContain("前消防員");
          yield "沈奕原本是個消防員，加班後的疲憊夜裡，世界忽然崩解成白光，將他拖入了陌生的空間。";
          return;
        }
        // gm-notes / item/skill/dungeon 骨架：不卡住，直接回應
        yield "# 內容\n";
      },
    };

    await initWorld({ worldDir, repoRoot, client, input: {}, today: "2026-06-25", logger: createLogger() });

    const journal = await readFile(path.join(worldDir, "journal.md"), "utf8");
    expect(journal).toContain("沈奕原本是個消防員");
    expect(journal).not.toContain("新世界建立，主角剛被系統選中。");
  });

  it("initWorld 完成後 .pending-opening 存在（ISO timestamp）", async () => {
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("設定設計師")) { yield "# 世界設定（World Setting）\n\n冷酷系統。\n"; return; }
        if (system.includes("角色設計師")) { yield "# 主角檔案\n\n沈奕。\n"; return; }
        yield "# 內容\n";
      },
    };
    await initWorld({ worldDir, repoRoot, client, input: {}, today: "2026-06-28", logger: createLogger() });
    const content = await readFile(path.join(worldDir, ".pending-opening"), "utf8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

});

describe("replaceProtagonist 主角結算整合", () => {
  let repoRoot: string;
  let worldDir: string;

  /** 回傳任意文字的 fake LLM client（供退場摘要、新主角生成、墓誌銘評語等多次呼叫使用） */
  const fakeMultiClient: LlmClient = {
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
      yield "這是一段測試回應，供所有 LLM 呼叫使用。";
    },
  };

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-replace-prot-"));
    worldDir = path.join(repoRoot, "world");
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    await writeFile(path.join(worldDir, "setting.md"), "# 世界設定\n\n真實世界。\n", "utf8");
    await writeFile(path.join(worldDir, "gm-notes.md"), "# 隱藏真相\n\n秘密。\n", "utf8");
    await writeFile(path.join(worldDir, "now.md"), "- 當前篇章：終章\n- 進行中的副本：無\n- 最後更新：[2026-06-26] x\n", "utf8");
    // 需有日誌內容，讓快照有意義
    await writeFile(path.join(worldDir, "journal.md"), "# 主空間日誌（Journal）\n\n## [2026-06-25] 舊日誌\n\n舊主角的冒險開始了。\n", "utf8");
    await writeFile(path.join(worldDir, "characters", "protagonist.md"), "- 姓名：沈奕\n- 當前積分：100\n", "utf8");
    await writeFile(path.join(worldDir, "characters", "index.md"), "| ID | 姓名 |\n| protagonist | 沈奕 |\n", "utf8");
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("replaceProtagonist 會先做主角結算，再重置 active protagonist/journal", async () => {
    await replaceProtagonist({
      repoRoot, worldDir, client: fakeMultiClient, protagonistSeed: {}, today: "2026-06-26", logger: createLogger(),
    });
    const playerMd = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(playerMd).toContain("已結算主角代數：1");
    expect(playerMd).toContain("| epi-");
    expect(await readFile(path.join(worldDir, "journal.md"), "utf8")).toContain("新主角接替");
  });
});
