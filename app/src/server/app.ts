import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig } from "../config.js";
import { loadState } from "../engine/context.js";
import { isWorldInitialized } from "../engine/world-status.js";
import { runMainSpaceTurn, runDungeonTurn, type PendingLoreSync } from "../engine/turn/index.js";
import { enterDungeon, formatActiveDungeon, parseActiveDungeon, renameLogAfterSettle } from "../engine/dungeon.js";
import { generateSecrets, setNowActiveDungeon } from "../engine/turn/dungeon-transition.js";
import { readBestEffort } from "../engine/turn/shared.js";
import { createOpenAiClient, type LlmClient } from "../llm/client.js";
import { commitWorld } from "../git/commit.js";
import { getAppVersion, type AppVersionInfo } from "../git/version.js";
import { createLogger, type Logger } from "../logger.js";
import { createRecallIndex } from "../recall/index.js";
import type { RecallIndex } from "../recall/store.js";
import { initWorld, endWorld, replaceProtagonist } from "../engine/world-ops.js";
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
  pacingClient?: LlmClient;
  /** 世界初始化用的 client（選填）；未提供時退回 config.lore 的 model/端點（與 lore 抽取共用同一顆，初始化是結構化長文生成，定性相近），缺 config.lore 才退回主 client */
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
          // Layer 2 fast-control 輸出的 JSON 偶爾在欄位較長（如 commit_summary）時被預設 max_tokens
          // （部分後端如 diffusiongemma 預設僅 256）截斷導致解析失敗，顯式調高避免截斷。
          { label: "control", maxTokens: 2048 },
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
          { label: "lore", maxTokens: 8192 },
        )
      : undefined);

  // 世界初始化：沿用 lore 的 model/端點（結構化長文生成，定性相近）；
  // 若 lore 端點不可用或 context 不足，退回主 client。
  // 初始化需要生成多份完整文件，務必確保 initClient 端點的 max_model_len 夠大（建議 ≥ 16k）。
  const initClient: LlmClient =
    deps.initClient ??
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
          { label: "init", maxTokens: 16384 },
        )
      : makeClient(logger));

  const pacingClient: LlmClient | undefined =
    deps.pacingClient ??
    (config.pacing
      ? createOpenAiClient(
          {
            ...config,
            openai: {
              baseUrl: config.pacing.baseUrl,
              apiKey: config.openai.apiKey,
              model: config.pacing.model,
            },
          },
          logger,
          { label: "pacing" },
        )
      : undefined);

  // 本服務只跑單一主角、單一世界的一條故事線（見 CLAUDE.md），所以整個 server 共用一個
  // pendingLoreSync handle 即可：保證任一回合的 Layer 3 在下一回合（不論哪個請求觸發）開始前落地完。
  const pendingLoreSync: PendingLoreSync = { promise: null };

  // 單一回合鎖：自動推進可能讓一次 /api/turn 跑很久，此時若玩家重整網頁再送出新行動，
  // 會有兩個 runTurnLoop 並行寫 world/ 並各自 commit，互相覆寫/搶鎖。同一時間只允許一個回合在跑。
  let turnInProgress = false;

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
      | { choice: "keep-world"; protagonistSeed?: import("../engine/protagonist-seed.js").ProtagonistSeed }
      | { choice: "end-world" };
    const opLogger = logger.child({ op: "world-protagonist" });
    try {
      if (body.choice === "end-world") {
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

  // 推進主空間/副本敘事回合，以 SSE 串流 delta/done 事件
  server.post("/api/turn", async (req, reply) => {
    const input = (req.body as { input?: string })?.input ?? "";
    const turnId = randomUUID();
    const turnLogger = logger.child({ turnId });

    if (existsSync(path.join(config.worldDir, ".pending-death"))) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      reply.raw.write(
        `data: ${JSON.stringify({ type: "error", message: "主角已死亡，請先完成換代或封存抉擇" })}\n\n`,
      );
      reply.raw.end();
      return;
    }

    if (turnInProgress) {
      return reply.code(409).send({ error: "上一回合仍在執行中，請稍候再試" });
    }
    turnInProgress = true;

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

      // 1. 讀狀態決定跑哪種回合
      const state = await loadState(config.worldDir, turnLogger);
      const turnDeps = {
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
        pacingClient,
        nudgeWindowSize: config.nudge.windowSize,
        nudgeSimilarityThreshold: config.nudge.similarityThreshold,
        pacingReviewInterval: config.pacingReviewInterval,
      };
      const gen = state.mode === "dungeon"
        ? runDungeonTurn(turnDeps, input)
        : runMainSpaceTurn(turnDeps, input);

      // 2. 逐事件轉發，截留 done
      let done: Extract<import("../engine/turn/types.js").TurnEvent, { type: "done" }> | null = null;
      for await (const ev of gen) {
        if (ev.type === "warning") turnLogger.warn({ ev }, "回合警告事件");
        if (ev.type === "done") { done = ev; continue; }
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      if (!done) {
        turnLogger.warn("/api/turn 未收到 done 事件，異常降級");
        return;
      }

      // 3. 處理轉場
      if (done.modeTransition === "enter_dungeon" && done.transitionDungeonId) {
        await pendingLoreSync.promise;
        const settingText = await readBestEffort(path.join(config.worldDir, "setting.md"));
        const secretsText = await generateSecrets(makeClient(turnLogger), settingText, done.transitionDungeonId);
        const active = await enterDungeon(config.worldDir, {
          dungeonId: done.transitionDungeonId,
          today: todayISO(),
          protagonistSummary: `${state.protagonist.name}（積分 ${state.protagonist.points}）`,
          goal: done.transitionDungeonGoal?.trim() || "（待劇情揭露）",
          secretsText,
        }, turnLogger);
        await setNowActiveDungeon(config.worldDir, formatActiveDungeon(active), {
          date: todayISO(),
          summary: `進入副本 ${active.dungeonId}`,
        });
        await makeCommit(turnLogger)(`進入副本 ${active.dungeonId} ${active.runId}`);
        reply.raw.write(`data: ${JSON.stringify({ type: "transition", to: "dungeon", dungeonId: active.dungeonId })}\n\n`);
        // 合成 done
        done = { ...done, modeTransition: null, suggestedActions: ["順勢而為"], awaitingUserInput: true };
      }

      if (done.modeTransition === "settle_dungeon") {
        await pendingLoreSync.promise;
        const activeForSettle = parseActiveDungeon(state.now.activeDungeon);
        if (activeForSettle) await renameLogAfterSettle(config.worldDir, activeForSettle.dungeonId, turnLogger);
        await setNowActiveDungeon(config.worldDir, "無", { date: todayISO(), summary: "副本結算，返回安全區" });
        await makeCommit(turnLogger)("副本結算，返回安全區");
        reply.raw.write(`data: ${JSON.stringify({ type: "transition", to: "main-space" })}\n\n`);
        done = { ...done, modeTransition: null, suggestedActions: ["順勢而為"], awaitingUserInput: true };
      }

      // 4. fallback 按鈕
      if (done.suggestedActions.length === 0) {
        done = { ...done, suggestedActions: ["順勢而為"] };
      }

      // 5. 送出最終 done
      reply.raw.write(`data: ${JSON.stringify(done)}\n\n`);

      turnLogger.info({ durationMs: Date.now() - startedAt }, "/api/turn 完成");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      turnLogger.error({ err, durationMs: Date.now() - startedAt }, "/api/turn 失敗");
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } finally {
      turnInProgress = false;
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
