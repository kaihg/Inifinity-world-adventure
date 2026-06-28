import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { loadState } from "../../engine/context.js";
import type { AppVersionInfo } from "../../git/version.js";
import type { Logger } from "../../logger.js";

export interface StateRouteDeps {
  config: AppConfig;
  logger: Logger;
  versionPromise: Promise<AppVersionInfo | null>;
}

export function registerStateRoutes(server: FastifyInstance, deps: StateRouteDeps): void {
  const { config, logger, versionPromise } = deps;

  server.get("/api/health", async () => {
    return { ok: true, model: config.openai.model };
  });

  server.get("/api/config", async () => {
    return { typewriterIntervalMs: config.typewriterIntervalMs };
  });

  server.get("/api/version", async () => {
    return (await versionPromise) ?? { hash: "unknown", message: "" };
  });

  server.get("/api/state", async () => {
    return loadState(config.worldDir, logger);
  });
}
