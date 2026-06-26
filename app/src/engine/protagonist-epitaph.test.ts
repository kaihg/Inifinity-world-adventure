import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { createLogger } from "../logger.js";
import { settleProtagonist } from "./protagonist-epitaph.js";

/** fakeClient：回傳含「主神評語」的測試用墓誌銘 */
const fakeClient: LlmClient = {
  // eslint-disable-next-line require-yield
  async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
    yield "主神評語：測試評語";
  },
};

/** fakeClient：模擬 LLM 呼叫失敗 */
const failClient: LlmClient = {
  async *streamChat(): AsyncIterable<string> {
    throw new Error("LLM 連線失敗");
  },
};

describe("settleProtagonist", () => {
  let repoRoot: string;
  let worldDir: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "iwa-epitaph-"));
    worldDir = path.join(repoRoot, "world");
    await mkdir(path.join(worldDir, "characters"), { recursive: true });

    // 建立最基本的世界檔案（含 UUID 供 readWorldUuid 使用）
    await writeFile(
      path.join(worldDir, "setting.md"),
      "# 世界設定（World Setting）\n\n- 世界 UUID：550e8400-e29b-41d4-a716-446655440000\n\n真實世界。\n",
      "utf8",
    );
    await writeFile(
      path.join(worldDir, "journal.md"),
      "# 主空間日誌（Journal）\n\n## [2026-06-26] 舊日誌\n\n一些劇情。\n",
      "utf8",
    );
    await writeFile(
      path.join(worldDir, "characters", "protagonist.md"),
      "# 主角檔案\n\n沈奕。\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("settleProtagonist 會建立 epitaph 目錄並封存 journal/protagonist", async () => {
    const result = await settleProtagonist({
      repoRoot,
      worldDir,
      client: fakeClient,
      logger: createLogger(),
      today: "2026-06-26",
      endingType: "死亡",
      protagonistGeneration: 1,
    });

    expect(await readFile(path.join(result.epitaphDir, "journal.md"), "utf8")).toContain("舊日誌");
    expect(await readFile(path.join(result.epitaphDir, "protagonist.md"), "utf8")).toContain("沈奕");
    expect(await readFile(path.join(result.epitaphDir, "epitaph.md"), "utf8")).toContain("主神評語");
  });

  it("settleProtagonist 回傳正確的 epitaphId 格式", async () => {
    const result = await settleProtagonist({
      repoRoot,
      worldDir,
      client: fakeClient,
      logger: createLogger(),
      today: "2026-06-26",
      endingType: "死亡",
      protagonistGeneration: 1,
    });

    expect(result.epitaphId).toBe("epi-20260626-001");
    expect(result.epitaphDir).toContain("epi-20260626-001");
  });

  it("settleProtagonist 會更新 meta/player.md 的已結算主角代數", async () => {
    await settleProtagonist({
      repoRoot,
      worldDir,
      client: fakeClient,
      logger: createLogger(),
      today: "2026-06-26",
      endingType: "死亡",
      protagonistGeneration: 1,
    });

    const playerMd = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(playerMd).toContain("已結算主角代數：1");
  });

  it("settleProtagonist 會在 meta/player.md 中追加墓誌銘索引條目", async () => {
    await settleProtagonist({
      repoRoot,
      worldDir,
      client: fakeClient,
      logger: createLogger(),
      today: "2026-06-26",
      endingType: "主動封存",
      protagonistGeneration: 1,
    });

    const playerMd = await readFile(path.join(repoRoot, "meta", "player.md"), "utf8");
    expect(playerMd).toContain("| epi-");
    expect(playerMd).toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(playerMd).toContain("主動封存");
  });

  it("LLM 呼叫失敗時安全降級，不拋錯，epitaph.md 仍寫入佔位文字", async () => {
    const result = await settleProtagonist({
      repoRoot,
      worldDir,
      client: failClient,
      logger: createLogger(),
      today: "2026-06-26",
      endingType: "隨世界結束",
      protagonistGeneration: 2,
    });

    const epitaphContent = await readFile(path.join(result.epitaphDir, "epitaph.md"), "utf8");
    expect(epitaphContent).toContain("主神評語");
    // 確認是降級文字（不含 LLM 實際輸出），不應拋錯
    expect(epitaphContent).toBeTruthy();
  });

  it("journal.md 不存在時使用佔位文字，不拋錯", async () => {
    await rm(path.join(worldDir, "journal.md"), { force: true });

    const result = await settleProtagonist({
      repoRoot,
      worldDir,
      client: fakeClient,
      logger: createLogger(),
      today: "2026-06-26",
      endingType: "死亡",
      protagonistGeneration: 1,
    });

    const journalContent = await readFile(path.join(result.epitaphDir, "journal.md"), "utf8");
    expect(journalContent).toBeTruthy();
  });

  it("protagonist.md 不存在時使用佔位文字，不拋錯", async () => {
    await rm(path.join(worldDir, "characters", "protagonist.md"), { force: true });

    const result = await settleProtagonist({
      repoRoot,
      worldDir,
      client: fakeClient,
      logger: createLogger(),
      today: "2026-06-26",
      endingType: "死亡",
      protagonistGeneration: 1,
    });

    const protagonistContent = await readFile(path.join(result.epitaphDir, "protagonist.md"), "utf8");
    expect(protagonistContent).toBeTruthy();
  });
});
