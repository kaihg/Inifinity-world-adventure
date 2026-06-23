import { describe, it, expect } from "vitest";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { logger } from "../../logger.js";
import { callLoreRewrite, type LoreRewriteCategory } from "./lore-rewrite.js";

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
});
