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
  /** 角色意圖 LLM（選填）；缺省時 engine 沿用主 client */
  character?: {
    baseUrl: string;
    model: string;
  };
  /** 結構控制抽取 LLM（副大腦，選填）；缺省時 engine 沿用主 client */
  control?: {
    baseUrl: string;
    model: string;
  };
  /** 語意檢索（recall）設定；derived cache，不進 git，預設關閉（需下載嵌入模型） */
  recall: {
    enabled: boolean;
    indexDir: string;
    topK: number;
  };
}

const DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o",
  port: 5173,
  host: "127.0.0.1",
  authorName: "Infinity World Engine",
  authorEmail: "engine@localhost",
  autoAdvanceMax: 4,
  recallTopK: 5,
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

/** 預設語意索引目錄：app/.recall-index（derived cache，不進 git，可隨時刪除重建） */
function defaultRecallIndexDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = <repo>/app/src（或 build 後 <repo>/app/dist）→ 回到 <repo>/app/.recall-index
  return path.resolve(here, "..", ".recall-index");
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
    character:
      env.CHARACTER_OPENAI_BASE_URL && env.CHARACTER_MODEL
        ? {
            baseUrl: env.CHARACTER_OPENAI_BASE_URL,
            model: env.CHARACTER_MODEL,
          }
        : undefined,
    control:
      env.CONTROL_OPENAI_BASE_URL && env.CONTROL_MODEL
        ? {
            baseUrl: env.CONTROL_OPENAI_BASE_URL,
            model: env.CONTROL_MODEL,
          }
        : undefined,
    recall: {
      enabled: env.RECALL_ENABLED === "true" || env.RECALL_ENABLED === "1",
      indexDir: env.RECALL_INDEX_DIR ? path.resolve(env.RECALL_INDEX_DIR) : defaultRecallIndexDir(),
      topK: parsePositiveInt(env.RECALL_TOP_K, DEFAULTS.recallTopK),
    },
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
