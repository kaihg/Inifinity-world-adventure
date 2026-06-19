import OpenAI from "openai";
import type { AppConfig } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * LLM 後端抽象。回合引擎只依賴這個介面，方便測試注入 fake，
 * 也讓部署者自由替換 OpenAI 相容端點（自架 vLLM/Ollama/LM Studio…）。
 */
export interface LlmClient {
  /** 串流對話，逐段 yield 文字 delta */
  streamChat(messages: ChatMessage[]): AsyncIterable<string>;
}

/** 以 OpenAI 相容端點實作的 LlmClient */
export function createOpenAiClient(config: AppConfig): LlmClient {
  const openai = new OpenAI({
    baseURL: config.openai.baseUrl,
    apiKey: config.openai.apiKey || "not-needed",
  });

  return {
    async *streamChat(messages: ChatMessage[]): AsyncIterable<string> {
      const stream = await openai.chat.completions.create({
        model: config.openai.model,
        messages,
        stream: true,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}
