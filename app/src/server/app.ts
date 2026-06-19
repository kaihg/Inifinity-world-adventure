import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { loadState } from "../engine/context.js";
import { runMainSpaceTurn } from "../engine/turn.js";
import { createOpenAiClient, type LlmClient } from "../llm/client.js";
import { commitWorld } from "../git/commit.js";

// app/src/server/app.ts → app/web
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

/** 可注入的相依（測試以 fake 取代真實 LLM / git） */
export interface ServerDeps {
  client?: LlmClient;
  commit?: (message: string) => Promise<boolean>;
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
  const client = deps.client ?? createOpenAiClient(config);
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
    return { ok: true, model: config.openai.model };
  });

  // resume 入口：決定論地讀 world/ 回傳當前局勢
  server.get("/api/state", async () => {
    return loadState(config.worldDir);
  });

  // 推進一個主空間敘事回合，以 SSE 串流 delta/done 事件
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
      for await (const ev of runMainSpaceTurn({ client, worldDir: config.worldDir, commit }, input)) {
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  server.get("/", async (_req, reply) => {
    const html = await readFile(path.join(WEB_DIR, "index.html"), "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });

  return server;
}

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
  }
}
