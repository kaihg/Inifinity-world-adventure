import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { loadState } from "../engine/context.js";

// app/src/server/app.ts → app/web
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

/**
 * 建立 Fastify app（不綁定 port，方便測試用 .inject()）。
 * 路由會隨後續 Phase 逐步掛載；Phase 0 只有健康檢查。
 */
export function buildServer(config: AppConfig): FastifyInstance {
  const server = Fastify({ logger: false });

  // 讓後續路由能取用設定
  server.decorate("config", config);

  server.get("/api/health", async () => {
    return { ok: true, model: config.openai.model };
  });

  // resume 入口：決定論地讀 world/ 回傳當前局勢
  server.get("/api/state", async () => {
    return loadState(config.worldDir);
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
