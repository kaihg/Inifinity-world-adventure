import { describe, it, expect } from "vitest";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { summarizeNpcStatus } from "./npc-status-summary.js";

function fakeClient(chunks: string[]): LlmClient {
  return {
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
      for (const c of chunks) yield c;
    },
  };
}

describe("summarizeNpcStatus", () => {
  it("回傳清理後的單行摘要", async () => {
    const status = await summarizeNpcStatus({
      name: "葉晴",
      characterMd: "# 葉晴\n對沈奕的信任進一步提升",
      client: fakeClient(["信任提升，主動分享情報"]),
    });
    expect(status).toBe("信任提升，主動分享情報");
  });

  it("移除換行與表格分隔符，並限長", async () => {
    const longLine = "甲".repeat(50);
    const status = await summarizeNpcStatus({
      name: "葉晴",
      characterMd: "# 葉晴",
      client: fakeClient([`第一行 | 含分隔符\n第二行${longLine}`]),
    });
    expect(status).not.toContain("|");
    expect(status).not.toContain("\n");
    expect(status.length).toBeLessThanOrEqual(40);
  });

  it("client 拋錯時回空字串而非拋出", async () => {
    const throwingClient: LlmClient = {
      async *streamChat() {
        throw new Error("LLM 掛了");
        yield "";
      },
    };
    const status = await summarizeNpcStatus({
      name: "葉晴",
      characterMd: "# 葉晴",
      client: throwingClient,
    });
    expect(status).toBe("");
  });

  it("回應為空白時回空字串", async () => {
    const status = await summarizeNpcStatus({
      name: "葉晴",
      characterMd: "# 葉晴",
      client: fakeClient(["   \n   "]),
    });
    expect(status).toBe("");
  });
});
