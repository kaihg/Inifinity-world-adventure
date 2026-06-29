import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "../config.js";
import { createOpenAiClient, type LlmClient } from "../llm/client.js";
import { commitWorld } from "../git/commit.js";
import { getAppVersion, type AppVersionInfo } from "../git/version.js";
import { createLogger, type Logger } from "../logger.js";
import { createRecallIndex } from "../recall/index.js";
import type { RecallIndex } from "../recall/store.js";
import type { PendingLoreSync } from "../engine/turn/index.js";
import { registerStateRoutes } from "./routes/state.js";
import { registerWorldRoutes } from "./routes/world.js";
import { registerTurnRoutes, type TurnState } from "./routes/turn.js";
import { registerLintRoute } from "./routes/lint.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WEB_BUILD_DIR = path.join(APP_ROOT, "web-dist");

/** 可注入的相依（測試以 fake 取代真實 LLM / git） */
export interface ServerDeps {
  client?: LlmClient;
  characterClient?: LlmClient;
  controlClient?: LlmClient;
  loreClient?: LlmClient;
  pacingClient?: LlmClient;
  /** 世界初始化用的 client（選填）；未提供時退回 config.lore 的 model/端點，缺 config.lore 才退回主 client */
  initClient?: LlmClient;
  commit?: (message: string) => Promise<boolean>;
  logger?: Logger;
  recall?: RecallIndex;
  version?: AppVersionInfo | null;
}

/**
 * 建立 Fastify app（不綁定 port，方便測試用 .inject()）。
 * deps 用於測試注入 fake client / commit；正式環境留空走真實實作。
 */
export function buildServer(config: AppConfig, deps: ServerDeps = {}): FastifyInstance {
  const logger = deps.logger ?? createLogger({ level: config.logLevel });
  const server = Fastify({ logger: logger as unknown as FastifyBaseLogger });

  server.decorate("config", config);

  const repoRoot = path.dirname(config.worldDir);

  const makeClient = (turnLogger: Logger): LlmClient =>
    deps.client ?? createOpenAiClient(config, turnLogger, { label: "main" });

  const characterClient: LlmClient | undefined =
    deps.characterClient ??
    (config.character
      ? createOpenAiClient(
          { ...config, openai: { baseUrl: config.character.baseUrl, apiKey: config.openai.apiKey, model: config.character.model } },
          logger,
          { label: "character" },
        )
      : undefined);

  const controlClient: LlmClient | undefined =
    deps.controlClient ??
    (config.control
      ? createOpenAiClient(
          { ...config, openai: { baseUrl: config.control.baseUrl, apiKey: config.openai.apiKey, model: config.control.model } },
          logger,
          // Layer 2 fast-control 輸出的 JSON 偶爾在欄位較長時被部分後端預設 max_tokens 截斷，顯式調高避免。
          { label: "control", maxTokens: 2048 },
        )
      : undefined);

  const loreClient: LlmClient | undefined =
    deps.loreClient ??
    (config.lore
      ? createOpenAiClient(
          { ...config, openai: { baseUrl: config.lore.baseUrl, apiKey: config.openai.apiKey, model: config.lore.model } },
          logger,
          { label: "lore", maxTokens: 8192 },
        )
      : undefined);

  // 世界初始化沿用 lore 的 model/端點（結構化長文生成，定性相近）；缺 lore 退回主 client。
  const initClient: LlmClient =
    deps.initClient ??
    (config.lore
      ? createOpenAiClient(
          { ...config, openai: { baseUrl: config.lore.baseUrl, apiKey: config.openai.apiKey, model: config.lore.model } },
          logger,
          { label: "init", maxTokens: 16384 },
        )
      : makeClient(logger));

  const pacingClient: LlmClient | undefined =
    deps.pacingClient ??
    (config.pacing
      ? createOpenAiClient(
          { ...config, openai: { baseUrl: config.pacing.baseUrl, apiKey: config.openai.apiKey, model: config.pacing.model } },
          logger,
          { label: "pacing" },
        )
      : undefined);

  const pendingLoreSync: PendingLoreSync = { promise: null };

  const turnState: TurnState = { turnInProgress: false, currentTurnBuffer: null };

  const recall: RecallIndex | undefined =
    deps.recall ?? (config.recall.enabled ? createRecallIndex(config.recall.indexDir) : undefined);

  const makeCommit = (turnLogger: Logger): ((message: string) => Promise<boolean>) =>
    deps.commit ??
    ((message: string) => {
      if (config.debug) {
        turnLogger.debug({ message }, "Debug 模式：跳過自動 commit");
        return Promise.resolve(false);
      }
      return commitWorld({
        repoRoot,
        message,
        authorName: config.git.authorName,
        authorEmail: config.git.authorEmail,
        logger: turnLogger,
      });
    });

  const versionPromise: Promise<AppVersionInfo | null> =
    deps.version !== undefined ? Promise.resolve(deps.version) : getAppVersion(repoRoot);

  registerStateRoutes(server, { config, logger, versionPromise });
  registerWorldRoutes(server, { config, logger, repoRoot, initClient, makeClient, makeCommit });
  registerLintRoute(server, config.worldDir);
  registerTurnRoutes(server, {
    config,
    logger,
    repoRoot,
    state: turnState,
    makeClient,
    makeCommit,
    characterClient,
    controlClient,
    loreClient,
    pacingClient,
    pendingLoreSync,
    recall,
  });

  if (existsSync(WEB_BUILD_DIR)) {
    server.register(fastifyStatic, { root: WEB_BUILD_DIR });
  } else {
    server.get("/", async (_req, reply) => {
      reply.type("text/html; charset=utf-8").send(
        `<!doctype html><html lang="zh-Hant"><meta charset="utf-8">` +
          `<title>無限世界冒險</title><body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;padding:2rem">` +
          `<h1>無限世界冒險</h1><p>前端尚未 build。開發請跑 <code>npm run dev</code>（Vite dev server），` +
          `或 <code>npm run build</code> 後由本服務提供。</p></body></html>`,
      );
    });
  }

  return server;
}

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
  }
}
