import { describe, it, expect } from "vitest";
import type { Logger } from "../../logger.js";
import { logger } from "../../logger.js";
import { trackLoreSync, runLoreSync } from "./lore-sync.js";
import type { PendingLoreSync } from "./types.js";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
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
          yield "# 副本 u-001 · 已揭露知識（Wiki）\n\n控制室位於地下二樓";
        }
      },
    };

    const deps: TurnDeps = {
      client: fakeClient,
      worldDir,
      commit: async () => true,
    };
    const plan: TurnPlan = {
      messages: [],
      buildFastControl: () => [],
      buildLoreSync: () => [{ role: "system", content: "Layer 3 prompt" }],
      appendRaw: async () => {},
      rawFilePath: path.join(worldDir, "dungeons", "u-001", "runs", "run-1.md"),
      dungeonId: "u-001",
    };

    await runLoreSync(deps, "敘事內容", "世界設定", plan, logger);

    const wikiPromptCalls = capturedSystemPrompts.filter((p) => p.includes("知識庫維護者"));
    expect(wikiPromptCalls.some((p) => p.includes("已揭露地圖/環境"))).toBe(true);

    const wikiContent = await readFile(path.join(worldDir, "dungeons", "u-001", "wiki.md"), "utf8");
    expect(wikiContent).toContain("控制室");
  });
});
