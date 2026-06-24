import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetWorldToPlaceholder, endWorld, initWorld } from "./world-ops.js";
import { isWorldInitialized } from "./world-status.js";
import { createLogger } from "../logger.js";
import type { LlmClient, ChatMessage } from "../llm/client.js";

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
