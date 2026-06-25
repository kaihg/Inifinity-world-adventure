import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";

export interface UsageLogEntry {
  timestamp: string;
  /** 哪一個 LLM client（main/character/control…），區分後端與用途 */
  label: string;
  model: string;
  baseUrl: string;
  durationMs: number;
  /** 從發出請求到收到第一個 token 的毫秒數（TTFT）*/
  firstTokenMs?: number;
  /** 後端未回傳 usage（例如某些自架端點不支援）時缺省 */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * 把一筆 LLM 呼叫的耗時與 token 用量 append 成一行 JSON，存進 derived 的本機 log 檔。
 * 失敗只記警告、不拋出，不應因為觀測性紀錄失敗而中斷正常回合流程。
 */
export async function appendUsageLog(
  filePath: string,
  entry: UsageLogEntry,
  logger: Logger = defaultLogger,
): Promise<void> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    logger.warn({ err, filePath }, "llm usage log 寫入失敗，略過");
  }
}
