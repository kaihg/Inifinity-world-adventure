import { describe, it, expect } from "vitest";
import type { Logger } from "../../logger.js";
import { logger } from "../../logger.js";
import { trackLoreSync, runLoreSync } from "./lore-sync.js";
import type { PendingLoreSync } from "./types.js";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { TurnDeps, TurnPlan } from "./types.js";

describe("trackLoreSync（永遠 resolve 語意）", () => {
  it("傳入會 reject 的 promise，包裝後 handle.promise 仍 resolve，並記一筆 warn", async () => {
    const warnCalls: unknown[] = [];
    const fakeLog = { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as Logger;
    const handle: PendingLoreSync = { promise: null };
    const rejecting = Promise.reject(new Error("Layer 3 任務本身炸了"));

    trackLoreSync(handle, rejecting, fakeLog);

    expect(handle.promise).not.toBeNull();
    await expect(handle.promise).resolves.toBeUndefined();
    expect(warnCalls).toHaveLength(1);
  });
});

describe("runLoreSync 的副本 wiki 重寫", () => {
  it("呼叫 callLoreRewrite 時 system prompt 含 dungeon 分類大綱關鍵字", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "dungeons", "u-001"), { recursive: true });

    const capturedSystemPrompts: string[] = [];
    const capturedWikiUserPrompts: string[] = [];
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
          capturedWikiUserPrompts.push(messages.find((m) => m.role === "user")?.content ?? "");
          yield "# 副本 u-001 · 已揭露知識（Wiki）\n\n控制室位於地下二樓";
        }
      },
    };

    const deps: TurnDeps = {
      client: fakeClient,
      worldDir,
      commit: async () => true,
    };
    // buildLoreSync は TurnPlan から除去済み
    const plan: TurnPlan = {
      messages: [],
      buildFastControl: () => [],
      appendRaw: async () => {},
      rawFilePath: path.join(worldDir, "dungeons", "u-001", "runs", "run-1.md"),
      dungeonId: "u-001",
    };

    await runLoreSync(deps, "敘事內容", "世界設定", plan, logger);

    const wikiPromptCalls = capturedSystemPrompts.filter((p) => p.includes("知識庫維護者"));
    expect(wikiPromptCalls.some((p) => p.includes("已揭露地圖/環境"))).toBe(true);

    // 副本 wiki 重寫也應收到 F 情境提示（與 entity 重寫對齊，明確標示在副本內）
    expect(capturedWikiUserPrompts.some((p) => p.includes("在副本「u-001」內"))).toBe(true);

    const wikiContent = await readFile(path.join(worldDir, "dungeons", "u-001.md"), "utf8");
    expect(wikiContent).toContain("控制室");
  });
});

describe("runLoreSync protagonist 落地（Task 2 以降：protagonist は Layer 3 では更新しない）", () => {
  async function setupWorld(): Promise<string> {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-prot-"));
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
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
      appendRaw: async () => {},
      rawFilePath: path.join(worldDir, "journal.md"),
    };
  }

  it("Layer 3 の出力に protagonist_points_delta があっても主角檔は変更しない（Task 2 で除去）", async () => {
    const worldDir = await setupWorld();
    const before = await readFile(path.join(worldDir, "characters", "protagonist.md"), "utf8");
    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("Layer 3")) {
          // protagonist_points_delta と protagonist_changed は LoreSyncSchema から除去済みのため無視される
          yield JSON.stringify({ state_changes: { protagonist_points_delta: 3, protagonist_changed: true } });
        } else if (system.includes("主角檔案維護者")) {
          // 呼ばれてはいけない
          yield "# 主角檔案\n- 姓名：沈奕\n- 當前積分：8\n\n## 物品欄\n- 戰術刀\n- 生鏽鐵管\n";
        }
      },
    };
    const deps: TurnDeps = { client: fakeClient, worldDir, commit: async () => true };
    await runLoreSync(deps, "沈奕撿起鐵管，完成測試得 3 分。", "設定", planFor(worldDir), logger);

    // protagonist.md は變更されない
    const after = await readFile(path.join(worldDir, "characters", "protagonist.md"), "utf8");
    expect(after).toBe(before);
  });
});
