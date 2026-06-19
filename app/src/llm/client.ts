import OpenAI from "openai";
import type { AppConfig } from "../config.js";
import { logger as defaultLogger, type Logger } from "../logger.js";

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
export function createOpenAiClient(config: AppConfig, logger: Logger = defaultLogger): LlmClient {
  const openai = new OpenAI({
    baseURL: config.openai.baseUrl,
    apiKey: config.openai.apiKey || "not-needed",
  });

  return {
    async *streamChat(messages: ChatMessage[]): AsyncIterable<string> {
      const startedAt = Date.now();
      const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
      logger.debug(
        { model: config.openai.model, baseUrl: config.openai.baseUrl, messageCount: messages.length, totalChars },
        "llm 呼叫開始",
      );

      let chunkCount = 0;
      let outChars = 0;
      try {
        const stream = await openai.chat.completions.create({
          model: config.openai.model,
          messages,
          stream: true,
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            chunkCount += 1;
            outChars += delta.length;
            yield delta;
          }
        }
        logger.debug(
          { model: config.openai.model, durationMs: Date.now() - startedAt, chunkCount, outChars },
          "llm 串流完成",
        );
      } catch (err) {
        logger.error(
          { err, model: config.openai.model, baseUrl: config.openai.baseUrl, durationMs: Date.now() - startedAt },
          "llm 串流失敗",
        );
        throw err;
      }
    },
  };
}
