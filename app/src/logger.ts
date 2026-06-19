import pino from "pino";

export type Logger = pino.Logger;

export interface CreateLoggerOptions {
  level?: string;
  /** 美化輸出（開發用，預設依 NODE_ENV 判斷） */
  pretty?: boolean;
}

/**
 * 建立結構化 logger。生產環境輸出單行 JSON 方便集中收集；
 * 開發/測試以外的環境預設帶 pino-pretty 美化，方便即時盯 console。
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const isTest = process.env.NODE_ENV === "test";
  // 測試環境永遠 silent，不受呼叫端傳入的 level 影響，避免測試輸出被 log 淹沒
  const level = isTest ? "silent" : opts.level ?? process.env.LOG_LEVEL ?? "info";
  const pretty = opts.pretty ?? (!isTest && process.env.NODE_ENV !== "production");

  return pino({
    level,
    transport: pretty
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        }
      : undefined,
  });
}

/** 共用的預設 logger（未顯式注入 logger 的呼叫點退回用這個） */
export const logger = createLogger();
