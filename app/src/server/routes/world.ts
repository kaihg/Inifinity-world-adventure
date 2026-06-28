import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { loadState } from "../../engine/context.js";
import { isWorldInitialized } from "../../engine/world-status.js";
import { initWorld, endWorld, replaceProtagonist } from "../../engine/world-ops.js";
import { clearRecallIndex } from "../../recall/clear-index.js";
import { todayISO } from "../../engine/turn/shared.js";
import { ensurePlayerMeta, readPlayerMetaCounts } from "../../engine/player-meta.js";
import { settleProtagonist } from "../../engine/protagonist-epitaph.js";
import type { LlmClient } from "../../llm/client.js";
import type { Logger } from "../../logger.js";

export interface WorldRouteDeps {
  config: AppConfig;
  logger: Logger;
  repoRoot: string;
  initClient: LlmClient;
  makeClient: (logger: Logger) => LlmClient;
  makeCommit: (logger: Logger) => (message: string) => Promise<boolean>;
}

export function registerWorldRoutes(server: FastifyInstance, deps: WorldRouteDeps): void {
  const { config, logger, repoRoot, initClient, makeClient, makeCommit } = deps;

  server.get("/api/world/status", async () => {
    return { initialized: await isWorldInitialized(config.worldDir) };
  });

  server.post("/api/world/init", async (req, reply) => {
    if (await isWorldInitialized(config.worldDir)) {
      return reply.code(409).send({ error: "世界已初始化，不可重複初始化" });
    }
    const body = (req.body ?? {}) as import("../../engine/world-ops.js").WorldInitInput;
    const opLogger = logger.child({ op: "world-init" });
    try {
      await initWorld({
        worldDir: config.worldDir,
        repoRoot,
        client: initClient,
        input: body,
        today: todayISO(),
        logger: opLogger,
      });
      await makeCommit(opLogger)("重置世界、生成新設定");
      await clearRecallIndex(config.recall.indexDir);
      return loadState(config.worldDir, opLogger);
    } catch (err) {
      opLogger.error({ err }, "world-init failed");
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
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
    try {
      const archivedTo = await endWorld({
        repoRoot,
        worldDir: config.worldDir,
        client: makeClient(opLogger),
        today: todayISO(),
        logger: opLogger,
      });
      await makeCommit(opLogger)("封存世界");
      await clearRecallIndex(config.recall.indexDir);
      return { archivedTo };
    } catch (err) {
      opLogger.error({ err }, "world-end failed");
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.post("/api/world/protagonist", async (req, reply) => {
    const pendingPath = path.join(config.worldDir, ".pending-death");
    if (!existsSync(pendingPath)) {
      return reply.code(409).send({ error: "目前不在主角死亡抉擇情境" });
    }
    const body = req.body as
      | { choice: "keep-world"; protagonistSeed?: import("../../engine/protagonist-seed.js").ProtagonistSeed }
      | { choice: "end-world" };
    const opLogger = logger.child({ op: "world-protagonist" });
    try {
      if (body.choice === "end-world") {
        await ensurePlayerMeta(repoRoot);
        const { protagonistGenerationCount } = await readPlayerMetaCounts(repoRoot);
        await settleProtagonist({
          repoRoot,
          worldDir: config.worldDir,
          client: makeClient(opLogger),
          logger: opLogger,
          today: todayISO(),
          endingType: "隨世界結束",
          protagonistGeneration: protagonistGenerationCount + 1,
        });
        const archivedTo = await endWorld({
          repoRoot, worldDir: config.worldDir, client: makeClient(opLogger),
          today: todayISO(), logger: opLogger,
        });
        await makeCommit(opLogger)("封存世界");
        await rm(pendingPath, { force: true });
        await clearRecallIndex(config.recall.indexDir);
        return { archivedTo };
      }

      // keep-world
      await replaceProtagonist({
        repoRoot, worldDir: config.worldDir, client: makeClient(opLogger),
        protagonistSeed: body.protagonistSeed ?? {}, today: todayISO(), logger: opLogger,
      });
      await makeCommit(opLogger)("主角換代");
      await rm(pendingPath, { force: true });
      await clearRecallIndex(config.recall.indexDir);
      return loadState(config.worldDir, opLogger);
    } catch (err) {
      opLogger.error({ err }, "world-protagonist failed");
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
