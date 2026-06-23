import { describe, it, expect } from "vitest";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { logger } from "../../logger.js";
import type { Logger } from "../../logger.js";
import { callLoreRewrite, type LoreRewriteCategory, generateEntitySecrets, rewriteLoreEntity } from "./lore-rewrite.js";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { TurnDeps } from "./types.js";

function capturingClient(response: string): { client: LlmClient; messages: ChatMessage[] } {
  const result = { messages: [] as ChatMessage[] } as { client: LlmClient; messages: ChatMessage[] };
  result.client = {
    async *streamChat(messages: ChatMessage[]) {
      result.messages = messages;
      yield response;
    },
  };
  return result;
}

function throwingClient(): LlmClient {
  return {
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
      throw new Error("LLM 呼叫失敗");
    },
  };
}

function fakeLogger(): { log: Logger; warnCalls: unknown[] } {
  const warnCalls: unknown[] = [];
  const log = { warn: (...args: unknown[]) => warnCalls.push(args) } as unknown as Logger;
  return { log, warnCalls };
}

describe("callLoreRewrite", () => {
  it("system prompt 含繁體用詞規範", async () => {
    const cap = capturingClient("新版內容");
    await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", "item", logger);
    const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system).toContain("避免使用中國大陸簡體中文慣用詞彙");
  });

  it.each([
    ["item", "外觀與基本辨識"],
    ["location", "已知規則或機關"],
    ["skill", "施展條件/限制"],
    ["npc", "與主角的關係"],
    ["dungeon", "已揭露地圖/環境"],
  ] as [LoreRewriteCategory, string][])(
    "category=%s 時 system prompt 含對應大綱關鍵字 %s",
    async (category, keyword) => {
      const cap = capturingClient("新版內容");
      await callLoreRewrite(cap.client, "世界設定", "片段", "標題", "", category, logger);
      const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain(keyword);
    },
  );

  it("client.streamChat 拋錯時回 null 並記一筆 warn，不往上拋", async () => {
    const { log, warnCalls } = fakeLogger();

    const result = await callLoreRewrite(throwingClient(), "世界設定", "片段", "文件標題", "", "item", log);

    expect(result).toBeNull();
    expect(warnCalls).toHaveLength(1);
  });
});

describe("generateEntitySecrets", () => {
  it.each([
    ["item", "道具設計者", "道具名稱"],
    ["location", "場景設計者", "場景名稱"],
    ["skill", "技能設計者", "技能名稱"],
  ] as [("item" | "location" | "skill"), string, string][])(
    "category=%s 時措辭正確（%s / %s）",
    async (category, roleKeyword, nounKeyword) => {
      const cap = capturingClient("隱藏設定內容");
      await generateEntitySecrets(cap.client, "世界設定", "測試實體", category, logger);
      const system = cap.messages.find((m) => m.role === "system")?.content ?? "";
      const user = cap.messages.find((m) => m.role === "user")?.content ?? "";
      expect(system).toContain(roleKeyword);
      expect(user).toContain(nounKeyword);
    },
  );

  it("client.streamChat 拋錯時回退預設文字並記一筆 warn，不往上拋", async () => {
    const { log, warnCalls } = fakeLogger();

    const result = await generateEntitySecrets(throwingClient(), "世界設定", "神祕道具", "item", log);

    expect(result).toBe("（生成失敗，待補）");
    expect(warnCalls).toHaveLength(1);
  });
});

describe("rewriteLoreEntity 標題", () => {
  it("道具 wiki 標題用 entity.name 而非 entity.id", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "world-"));
    await mkdir(path.join(worldDir, "items", "sword-001"), { recursive: true });

    const fakeClient: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
        yield systemContent.includes("劇透文件") ? "隱藏設定內容" : "# 淬毒匕首\n\n外觀描述";
      },
    };
    const deps: TurnDeps = {
      client: fakeClient,
      worldDir,
      commit: async () => true,
    };

    const result = await rewriteLoreEntity(
      deps,
      "世界設定",
      { id: "sword-001", category: "item", name: "淬毒匕首", excerpt: "主角拿到一把淬毒匕首" },
      logger,
    );

    expect(result).not.toBeNull();
    expect(result?.title).toBe("道具（淬毒匕首）");
  });
});
