import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "../config.js";
import { loadState } from "../engine/context.js";
import { isWorldInitialized } from "../engine/world-status.js";
import { runTurnLoop, type PendingLoreSync } from "../engine/turn/index.js";
import { createOpenAiClient, type LlmClient } from "../llm/client.js";
import { commitWorld } from "../git/commit.js";
import { getAppVersion, type AppVersionInfo } from "../git/version.js";
import { createLogger, type Logger } from "../logger.js";
import { createRecallIndex } from "../recall/index.js";
import type { RecallIndex } from "../recall/store.js";
import { initWorld, endWorld } from "../engine/world-ops.js";
import { clearRecallIndex } from "../recall/clear-index.js";
import { todayISO } from "../engine/turn/shared.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// app/src/server/app.ts → app/web（dev：原始檔；prod：Vite build 輸出 web-dist）
const WEB_DEV_DIR = path.join(APP_ROOT, "web");
const WEB_BUILD_DIR = path.join(APP_ROOT, "web-dist");

/** 可注入的相依（測試以 fake 取代真實 LLM / git） */
export interface ServerDeps {
  client?: LlmClient;
  characterClient?: LlmClient;
  controlClient?: LlmClient;
  loreClient?: LlmClient;
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

  // 讓後續路由能取用設定
  server.decorate("config", config);

  const repoRoot = path.dirname(config.worldDir);

  const makeClient = (turnLogger: Logger): LlmClient =>
    deps.client ?? createOpenAiClient(config, turnLogger, { label: "main" });

  // 啟動時建立一次，避免每回合重複建立 HTTP client
  const characterClient: LlmClient | undefined =
    deps.characterClient ??
    (config.character
      ? createOpenAiClient(
          {
            ...config,
            openai: {
              baseUrl: config.character.baseUrl,
              apiKey: config.openai.apiKey,
              model: config.character.model,
            },
          },
          logger,
          { label: "character" },
        )
      : undefined);

  const controlClient: LlmClient | undefined =
    deps.controlClient ??
    (config.control
      ? createOpenAiClient(
          {
            ...config,
            openai: {
              baseUrl: config.control.baseUrl,
              apiKey: config.openai.apiKey,
              model: config.control.model,
            },
          },
          logger,
          { label: "control" },
        )
      : undefined);

  const loreClient: LlmClient | undefined =
    deps.loreClient ??
    (config.lore
      ? createOpenAiClient(
          {
            ...config,
            openai: {
              baseUrl: config.lore.baseUrl,
              apiKey: config.openai.apiKey,
              model: config.lore.model,
            },
          },
          logger,
          { label: "lore" },
        )
      : undefined);

  // 本服務只跑單一主角、單一世界的一條故事線（見 CLAUDE.md），所以整個 server 共用一個
  // pendingLoreSync handle 即可：保證任一回合的 Layer 3 在下一回合（不論哪個請求觸發）開始前落地完。
  const pendingLoreSync: PendingLoreSync = { promise: null };

  // 啟動時建立一次（建構本身零 I/O，模型/索引延遲初始化）；未啟用時不建立，避免不必要的模型下載
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

  server.get("/api/health", async () => {
    return { ok: true, model: config.openai.model };
  });

  // 開發者用：app/ 最後一次功能性 commit 的 hash + message，啟動時算一次並快取
  const versionPromise: Promise<AppVersionInfo | null> =
    deps.version !== undefined ? Promise.resolve(deps.version) : getAppVersion(repoRoot);

  server.get("/api/version", async () => {
    return (await versionPromise) ?? { hash: "unknown", message: "" };
  });

  // resume 入口：決定論地讀 world/ 回傳當前局勢
  server.get("/api/state", async () => {
    return loadState(config.worldDir, logger);
  });

  // 前端開機判斷：世界是否已初始化（決定要不要顯示初始化精靈）
  server.get("/api/world/status", async () => {
    return { initialized: await isWorldInitialized(config.worldDir) };
  });

  server.post("/api/world/init", async (req, reply) => {
    if (await isWorldInitialized(config.worldDir)) {
      return reply.code(409).send({ error: "世界已初始化，不可重複初始化" });
    }
    const body = (req.body ?? {}) as import("../engine/world-ops.js").WorldInitInput;
    const opLogger = logger.child({ op: "world-init" });
    await initWorld({
      worldDir: config.worldDir,
      client: makeClient(opLogger),
      input: body,
      today: todayISO(),
      logger: opLogger,
    });
    await makeCommit(opLogger)("重置世界、生成新設定");
    await clearRecallIndex(config.recall);
    return loadState(config.worldDir, opLogger);
  });

  server.post("/api/world/end", async (req, reply) => {
    if (existsSync(path.join(config.worldDir, ".pending-death"))) {
      return reply.code(409).send({ error: "請先完成主角換代或結束世界的抉擇" });
    }
    const confirmText = (req.body as { confirmText?: string })?.confirmText;
    if (confirmText !== "封存") {
      return reply.code(400).send({ error: "確認文字不符" });
    }
    const opLogger = logger.child({ op: "world-end" });
    const archivedTo = await endWorld({
      repoRoot,
      worldDir: config.worldDir,
      client: makeClient(opLogger),
      today: todayISO(),
      logger: opLogger,
    });
    await makeCommit(opLogger)("封存世界");
    await clearRecallIndex(config.recall);
    return { archivedTo };
  });

  // 推進主空間敘事回合（含自動推進），以 SSE 串流 delta/auto-advance/done 事件
  server.post("/api/turn", async (req, reply) => {
    const input = (req.body as { input?: string })?.input ?? "";
    const turnId = randomUUID();
    const turnLogger = logger.child({ turnId });

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const startedAt = Date.now();
    turnLogger.info({ inputLength: input.length }, "/api/turn 開始");
    try {
      // 立刻寫入第一筆 ping 事件，建立首位元組資料，防止反向代理（如 Tailscale Serve）在 LLM 漫長 Prefill 時發生 30s 閘道超時
      reply.raw.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
      for await (const ev of runTurnLoop(
        {
          client: makeClient(turnLogger),
          characterClient,
          controlClient,
          loreClient,
          pendingLoreSync,
          worldDir: config.worldDir,
          commit: makeCommit(turnLogger),
          logger: turnLogger,
          recall,
          recallTopK: config.recall.topK,
        },
        input,
        config.autoAdvanceMax,
      )) {
        if (ev.type === "warning") turnLogger.warn({ ev }, "回合警告事件");
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      turnLogger.info({ durationMs: Date.now() - startedAt }, "/api/turn 完成");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      turnLogger.error({ err, durationMs: Date.now() - startedAt }, "/api/turn 失敗");
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  if (existsSync(WEB_BUILD_DIR)) {
    // prod：服務 Vite build（index.html + 雜湊 assets）
    server.register(fastifyStatic, { root: WEB_BUILD_DIR });
  } else {
    // dev / 尚未 build：給提示頁（dev 請用 Vite dev server，見 npm run dev）
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
