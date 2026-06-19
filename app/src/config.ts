import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  openai: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  port: number;
  host: string;
  debug: boolean;
  /** pino log level（trace/debug/info/warn/error/silent），預設 debug 模式給 debug，否則 info */
  logLevel: string;
  git: {
    authorName: string;
    authorEmail: string;
  };
  /** 單次 /api/turn 最多自動推進的回合數上限 */
  autoAdvanceMax: number;
  /** world/ 狀態目錄的絕對路徑 */
  worldDir: string;
}

const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  port: 5173,
  host: "127.0.0.1",
  authorName: "Infinity World Engine",
  authorEmail: "engine@localhost",
  autoAdvanceMax: 4,
};

/** 解析正整數，非法或非正數時退回預設 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/** 預設 world/ 目錄：由本檔位置（app/src/config.ts）回推到 repo 根的 world/ */
function defaultWorldDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = <repo>/app/src（或 build 後 <repo>/app/dist）→ 回到 <repo>/world
  return path.resolve(here, "..", "..", "world");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    openai: {
      baseUrl: env.OPENAI_BASE_URL || DEFAULTS.baseUrl,
      apiKey: env.OPENAI_API_KEY || "",
      model: env.MODEL || DEFAULTS.model,
    },
    port: parsePositiveInt(env.PORT, DEFAULTS.port),
    host: env.HOST || DEFAULTS.host,
    debug: env.DEBUG_MODE === "true" || env.DEBUG_MODE === "1",
    logLevel: env.LOG_LEVEL || (env.DEBUG_MODE === "true" || env.DEBUG_MODE === "1" ? "debug" : "info"),
    git: {
      authorName: env.GIT_AUTHOR_NAME || DEFAULTS.authorName,
      authorEmail: env.GIT_AUTHOR_EMAIL || DEFAULTS.authorEmail,
    },
    autoAdvanceMax: parsePositiveInt(env.AUTO_ADVANCE_MAX, DEFAULTS.autoAdvanceMax),
    worldDir: env.WORLD_DIR ? path.resolve(env.WORLD_DIR) : defaultWorldDir(),
  };
}

/** 回傳啟動時應提示的設定警示（缺值不致命，但要提醒部署者） */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (!config.openai.apiKey) {
    warnings.push(
      "未設定 OPENAI_API_KEY：呼叫 LLM 會失敗。自架且端點不需金鑰時可填任意非空值。",
    );
  }
  return warnings;
}
