import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "../config.js";
import { loadState } from "../engine/context.js";
import { runTurnLoop } from "../engine/turn.js";
import { createOpenAiClient, type LlmClient } from "../llm/client.js";
import { commitWorld } from "../git/commit.js";
import { writeEnvUpdates } from "../config-file.js";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// app/src/server/app.ts → app/web（dev：原始檔；prod：Vite build 輸出 web-dist）
const WEB_DEV_DIR = path.join(APP_ROOT, "web");
const WEB_BUILD_DIR = path.join(APP_ROOT, "web-dist");
const DEFAULT_ENV_PATH = path.join(APP_ROOT, ".env");

/** 可注入的相依（測試以 fake 取代真實 LLM / git / env 路徑） */
export interface ServerDeps {
  client?: LlmClient;
  commit?: (message: string) => Promise<boolean>;
  envPath?: string;
}

/**
 * 建立 Fastify app（不綁定 port，方便測試用 .inject()）。
 * deps 用於測試注入 fake client / commit；正式環境留空走真實實作。
 */
export function buildServer(config: AppConfig, deps: ServerDeps = {}): FastifyInstance {
  const server = Fastify({ logger: false });

  // 讓後續路由能取用設定
  server.decorate("config", config);

  const repoRoot = path.dirname(config.worldDir);
  const envPath = deps.envPath ?? DEFAULT_ENV_PATH;

  // 可在執行期由設定頁調整的 LLM 設定（apiKey 不外露到前端）
  const runtime = { baseUrl: config.openai.baseUrl, model: config.openai.model };
  const makeClient = (): LlmClient =>
    deps.client ??
    createOpenAiClient({
      ...config,
      openai: { ...config.openai, baseUrl: runtime.baseUrl, model: runtime.model },
    });

  const commit =
    deps.commit ??
    ((message: string) => {
      if (config.debug) {
        console.log(`[DEBUG] 偵測到 Debug 模式，跳過自動 commit：${message}`);
        return Promise.resolve(false);
      }
      return commitWorld({
        repoRoot,
        message,
        authorName: config.git.authorName,
        authorEmail: config.git.authorEmail,
      });
    });

  server.get("/api/health", async () => {
    return { ok: true, model: runtime.model };
  });

  // resume 入口：決定論地讀 world/ 回傳當前局勢
  server.get("/api/state", async () => {
    return loadState(config.worldDir);
  });

  // LLM 設定（不外露 apiKey）
  server.get("/api/config", async () => {
    return { baseUrl: runtime.baseUrl, model: runtime.model };
  });

  server.post("/api/config", async (req) => {
    const body = (req.body ?? {}) as { baseUrl?: string; model?: string };
    const updates: Record<string, string> = {};
    if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
      runtime.baseUrl = body.baseUrl.trim();
      updates.OPENAI_BASE_URL = runtime.baseUrl;
    }
    if (typeof body.model === "string" && body.model.trim()) {
      runtime.model = body.model.trim();
      updates.MODEL = runtime.model;
    }
    if (Object.keys(updates).length > 0) {
      await writeEnvUpdates(envPath, updates);
    }
    return { baseUrl: runtime.baseUrl, model: runtime.model };
  });

  // 推進主空間敘事回合（含自動推進），以 SSE 串流 delta/auto-advance/done 事件
  server.post("/api/turn", async (req, reply) => {
    const input = (req.body as { input?: string })?.input ?? "";

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      // 立刻寫入第一筆 ping 事件，建立首位元組資料，防止反向代理（如 Tailscale Serve）在 LLM 漫長 Prefill 時發生 30s 閘道超時
      reply.raw.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
      for await (const ev of runTurnLoop(
        { client: makeClient(), worldDir: config.worldDir, commit },
        input,
        config.autoAdvanceMax,
      )) {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
