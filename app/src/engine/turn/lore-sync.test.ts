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

    // 副本 wiki 重寫也應收到 F 情境提示（與 entity 重寫對齊，明確標示在副本內）
    expect(capturedWikiUserPrompts.some((p) => p.includes("在副本「u-001」內"))).toBe(true);

    const wikiContent = await readFile(path.join(worldDir, "dungeons", "u-001", "wiki.md"), "utf8");
    expect(wikiContent).toContain("控制室");
  });
});

describe("runLoreSync 的 touched_entities 校驗 gate（根因 A）", () => {
  it("黑名單 id（system）不觸發任何 wiki/角色檔落地", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "characters"), { recursive: true });

    let rewriteCalls = 0; // 知識庫維護者（callLoreRewrite）被呼叫的次數
    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("Layer 3")) {
          yield JSON.stringify({
            state_changes: {
              touched_entities: [
                { id: "system", category: "skill", name: "系統", excerpt: "系統發出公告" },
                { id: "none", category: "item", name: "無", excerpt: "什麼都沒有" },
              ],
            },
          });
        } else {
          rewriteCalls++;
          yield "不該被寫出的內容";
        }
      },
    };
    const deps: TurnDeps = { client: fakeClient, worldDir, commit: async () => true };
    const plan: TurnPlan = {
      messages: [],
      buildFastControl: () => [],
      buildLoreSync: () => [{ role: "system", content: "Layer 3 prompt" }],
      appendRaw: async () => {},
      rawFilePath: path.join(worldDir, "journal.md"),
    };

    await runLoreSync(deps, "敘事內容", "世界設定", plan, logger);

    // 校驗 gate 在呼叫 LLM 重寫前剔除假 entity → callLoreRewrite 完全不被呼叫
    expect(rewriteCalls).toBe(0);
    // 不應建出 skills/system 或 items/none 的 wiki
    await expect(readFile(path.join(worldDir, "skills", "system", "wiki.md"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(worldDir, "items", "none", "wiki.md"), "utf8")).rejects.toThrow();
  });
});
