import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";

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

  return server;
}

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
  }
}
