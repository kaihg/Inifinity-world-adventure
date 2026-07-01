import OpenAI from "openai";
import type { AppConfig } from "../config.js";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { appendUsageLog } from "./usage-log.js";

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
  /** 批次對話：等待全文再回傳（JSON 輸出場景） */
  chat(messages: ChatMessage[]): Promise<string>;
}

export interface CreateOpenAiClientOptions {
  /** 區分是哪一個 client（main/character/control…），寫進 usage log 方便分開統計花費 */
  label?: string;
  /** usage log 檔案路徑；缺省退回 config.usageLogPath */
  usageLogPath?: string;
  /** 覆寫 max_tokens；對輸出上限較低的模型（如 diffusiongemma 預設 256）必須顯式設定 */
  maxTokens?: number;
}

/** 以 OpenAI 相容端點實作的 LlmClient；每次呼叫的耗時與 token 用量會 append 進 usage log */
export function createOpenAiClient(
  config: AppConfig,
  logger: Logger = defaultLogger,
  opts: CreateOpenAiClientOptions = {},
): LlmClient {
  const openai = new OpenAI({
    baseURL: config.openai.baseUrl,
    apiKey: config.openai.apiKey || "not-needed",
  });
  const label = opts.label ?? "main";
  const usageLogPath = opts.usageLogPath ?? config.usageLogPath;
  const maxTokens = opts.maxTokens;

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
      let firstTokenMs: number | undefined;
      let usage: OpenAI.CompletionUsage | undefined;
      try {
        const stream = await openai.chat.completions.create({
          model: config.openai.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
            chunkCount += 1;
            outChars += delta.length;
            yield delta;
          }
          if (chunk.usage) usage = chunk.usage;
        }
        const durationMs = Date.now() - startedAt;
        logger.debug(
          { model: config.openai.model, durationMs, firstTokenMs, chunkCount, outChars, usage },
          "llm 串流完成",
        );
        await appendUsageLog(
          usageLogPath,
          {
            timestamp: new Date().toISOString(),
            label,
            model: config.openai.model,
            baseUrl: config.openai.baseUrl,
            durationMs,
            firstTokenMs,
            promptTokens: usage?.prompt_tokens,
            completionTokens: usage?.completion_tokens,
            totalTokens: usage?.total_tokens,
          },
          logger,
        );
      } catch (err) {
        logger.error(
          { err, model: config.openai.model, baseUrl: config.openai.baseUrl, durationMs: Date.now() - startedAt },
          "llm 串流失敗",
        );
        throw err;
      }
    },

    async chat(messages: ChatMessage[]): Promise<string> {
      const startedAt = Date.now();
      const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
      logger.debug(
        { model: config.openai.model, baseUrl: config.openai.baseUrl, messageCount: messages.length, totalChars },
        "llm batch 呼叫開始",
      );
      try {
        const resp = await openai.chat.completions.create({
          model: config.openai.model,
          messages,
          stream: false,
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        });
        const text = resp.choices[0]?.message?.content;
        if (text == null) throw new Error("LLM 回傳空 content（可能是 function_call 或 refusal 模式）");
        const durationMs = Date.now() - startedAt;
        logger.debug({ model: config.openai.model, durationMs, outChars: text.length }, "llm batch 完成");
        try {
          await appendUsageLog(
            usageLogPath,
            {
              timestamp: new Date().toISOString(),
              label,
              model: config.openai.model,
              baseUrl: config.openai.baseUrl,
              durationMs,
              promptTokens: resp.usage?.prompt_tokens,
              completionTokens: resp.usage?.completion_tokens,
              totalTokens: resp.usage?.total_tokens,
            },
            logger,
          );
        } catch (logErr) {
          logger.warn({ err: logErr }, "usage log 寫入失敗（不影響呼叫結果）");
        }
        return text;
      } catch (err) {
        logger.error(
          { err, model: config.openai.model, baseUrl: config.openai.baseUrl, durationMs: Date.now() - startedAt },
          "llm batch 呼叫失敗",
        );
        throw err;
      }
    },
  };
}
