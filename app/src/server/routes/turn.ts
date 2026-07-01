import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import { loadState, parseNow } from "../../engine/context.js";
import { applyNowChanges, serializeNow } from "../../engine/now.js";
import {
  runMainSpaceTurn,
  runDungeonTurn,
  type PendingLoreSync,
  type TurnEvent,
} from "../../engine/turn/index.js";
import {
  enterDungeon,
  formatActiveDungeon,
  parseActiveDungeon,
  renameLogAfterSettle,
} from "../../engine/dungeon.js";
import { appendDungeonStartMarker, appendDungeonEndMarker, generateSecrets, setNowActiveDungeon } from "../../engine/turn/dungeon-transition.js";
import { readBestEffort, todayISO, nowISOSeconds } from "../../engine/turn/shared.js";
import { sanitizeLoreId } from "../../engine/lore.js";
import { getTemplate } from "../../engine/template-loader.js";
import type { LlmClient } from "../../llm/client.js";
import type { Logger } from "../../logger.js";
import type { RecallIndex } from "../../recall/store.js";

export interface TurnBuffer {
  turnId: string;
  narrative: string;
  events: TurnEvent[];
  active: boolean;
}

/** 跨 turn 路由共享的可變狀態容器，由 buildServer 建立並以傳參方式共享 */
export interface TurnState {
  turnInProgress: boolean;
  currentTurnBuffer: TurnBuffer | null;
}

export interface TurnRouteDeps {
  config: AppConfig;
  logger: Logger;
  repoRoot: string;
  state: TurnState;
  makeClient: (logger: Logger) => LlmClient;
  makeCommit: (logger: Logger) => (message: string) => Promise<boolean>;
  characterClient?: LlmClient;
  controlClient?: LlmClient;
  loreClient?: LlmClient;
  pacingClient?: LlmClient;
  pendingLoreSync: PendingLoreSync;
  recall?: RecallIndex;
}

export function registerTurnRoutes(server: FastifyInstance, deps: TurnRouteDeps): void {
  const {
    config,
    logger,
    repoRoot,
    state,
    makeClient,
    makeCommit,
    characterClient,
    controlClient,
    loreClient,
    pacingClient,
    pendingLoreSync,
    recall,
  } = deps;

  server.get("/api/turn/status", async () => {
    return {
      active: state.currentTurnBuffer?.active ?? false,
      turnId: state.currentTurnBuffer?.turnId ?? null,
    };
  });

  server.get("/api/turn/stream", async (req, reply) => {
    const offsetParam = (req.query as { offset?: string }).offset;
    const offset = offsetParam !== undefined ? parseInt(offsetParam, 10) : 0;
    if (isNaN(offset) || offset < 0) {
      return reply.code(400).send({ error: "offset 必須為非負整數" });
    }

    if (!state.currentTurnBuffer) {
      return reply.code(204).send();
    }

    const buf = state.currentTurnBuffer;

    if (offset > buf.events.length) {
      return reply.code(410).send({ error: "offset 超出 buffer 範圍，請重新整理" });
    }

    if (!buf.active && offset >= buf.events.length) {
      return reply.code(204).send();
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    for (let i = offset; i < buf.events.length; i++) {
      reply.raw.write(`data: ${JSON.stringify(buf.events[i])}\n\n`);
    }

    if (!buf.active) {
      reply.raw.end();
      return;
    }

    let cursor = buf.events.length;
    const maxWaitMs = 5 * 60 * 1000;
    const pollMs = 100;
    const deadline = Date.now() + maxWaitMs;

    await new Promise<void>((resolve) => {
      let tick: ReturnType<typeof setInterval>;
      req.raw.on("close", () => {
        clearInterval(tick);
        resolve();
      });
      tick = setInterval(() => {
        while (cursor < buf.events.length) {
          reply.raw.write(`data: ${JSON.stringify(buf.events[cursor])}\n\n`);
          cursor++;
        }
        if (!buf.active || Date.now() > deadline) {
          clearInterval(tick);
          reply.raw.end();
          resolve();
        }
      }, pollMs);
    });
  });

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

    if (state.turnInProgress) {
      return reply.code(409).send({ error: "上一回合仍在執行中，請稍候再試" });
    }
    state.turnInProgress = true;
    state.currentTurnBuffer = { turnId, narrative: "", events: [], active: true };

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const startedAt = Date.now();
    turnLogger.info({ inputLength: input.length }, "/api/turn 開始");
    try {
      reply.raw.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);

      const stateData = await loadState(config.worldDir, turnLogger);

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
      const gen =
        stateData.mode === "dungeon"
          ? runDungeonTurn(turnDeps, input)
          : runMainSpaceTurn(turnDeps, input);

      let done: Extract<TurnEvent, { type: "done" }> | null = null;
      for await (const ev of gen) {
        if (ev.type === "warning") turnLogger.warn({ ev }, "回合警告事件");
        if (ev.type !== "done" && state.currentTurnBuffer) {
          if (ev.type === "delta") state.currentTurnBuffer.narrative += ev.text;
          state.currentTurnBuffer.events.push(ev);
        }
        if (ev.type === "done") { done = ev; continue; }
        reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
      if (!done) {
        turnLogger.warn("/api/turn 未收到 done 事件，異常降級");
        return;
      }

      let didTransition = false;

      if (done.modeTransition === "enter_dungeon" && !done.transitionDungeonId) {
        turnLogger.warn("mode_transition=enter_dungeon 但缺 transition_dungeon_id，無法進入副本，停在等玩家");
        try {
          const nowPath = path.join(config.worldDir, "now.md");
          const nowMd = await readFile(nowPath, "utf8");
          const now = applyNowChanges(
            parseNow(nowMd),
            { nextStep: "傳送中（副本目標定位中）" },
            { date: todayISO(), summary: "副本傳送程序已觸發，目標定位中" },
          );
          await writeFile(nowPath, serializeNow(now), "utf8");
        } catch (err) {
          turnLogger.warn({ err }, "guard 補寫 now.md 失敗，略過");
        }
        reply.raw.write(
          `data: ${JSON.stringify({ type: "warning", message: "系統判定要進入副本，但未能確定副本 id，暫停等玩家確認。" })}\n\n`,
        );
        done = { ...done, modeTransition: null };
      }

      if (done.modeTransition === "enter_dungeon" && done.transitionDungeonId && stateData.mode !== "dungeon") {
        const rawDungeonId = done.transitionDungeonId;
        const safeDungeonId = sanitizeLoreId(rawDungeonId);
        await pendingLoreSync.promise;
        const [settingText, secretsTemplate] = await Promise.all([
          readBestEffort(path.join(config.worldDir, "setting.md")),
          getTemplate("secrets", config.worldDir, repoRoot),
        ]);
        const secretsText = await generateSecrets(makeClient(turnLogger), settingText, safeDungeonId, secretsTemplate);
        const active = await enterDungeon(
          config.worldDir,
          {
            dungeonId: safeDungeonId,
            today: todayISO(),
            protagonistSummary: `${stateData.protagonist.name}（積分 ${stateData.protagonist.points}）`,
            goal: done.transitionDungeonGoal?.trim() || "（待劇情揭露）",
            secretsText,
          },
          turnLogger,
        );
        const dungeonRunId = `${active.dungeonId}-${active.runId}`;
        await appendDungeonStartMarker(config.worldDir, dungeonRunId, nowISOSeconds());
        await setNowActiveDungeon(config.worldDir, formatActiveDungeon(active), {
          date: todayISO(),
          summary: `進入副本 ${active.dungeonId}`,
        });
        await makeCommit(turnLogger)(`進入副本 ${active.dungeonId} ${active.runId}`);
        const enterTransEv = { type: "transition", to: "dungeon", dungeonId: active.dungeonId } as const;
        if (state.currentTurnBuffer) state.currentTurnBuffer.events.push(enterTransEv);
        reply.raw.write(`data: ${JSON.stringify(enterTransEv)}\n\n`);
        done = { ...done, modeTransition: null, suggestedActions: ["順勢而為"], awaitingUserInput: true };
        didTransition = true;
      }

      if (done.modeTransition === "settle_dungeon") {
        await pendingLoreSync.promise;
        const activeForSettle = parseActiveDungeon(stateData.now.activeDungeon);
        if (activeForSettle) {
          const settleRunId = `${activeForSettle.dungeonId}-${activeForSettle.runId}`;
          await appendDungeonEndMarker(config.worldDir, settleRunId);
          await renameLogAfterSettle(config.worldDir, activeForSettle.dungeonId, turnLogger);
        }
        await setNowActiveDungeon(config.worldDir, "無", { date: todayISO(), summary: "副本結算，返回安全區" });
        await makeCommit(turnLogger)("副本結算，返回安全區");
        const settleTransEv = { type: "transition", to: "main-space" } as const;
        if (state.currentTurnBuffer) state.currentTurnBuffer.events.push(settleTransEv);
        reply.raw.write(`data: ${JSON.stringify(settleTransEv)}\n\n`);
        done = { ...done, modeTransition: null, suggestedActions: ["順勢而為"], awaitingUserInput: true };
        didTransition = true;
      }

      if (didTransition) {
        try {
          done = { ...done, state: await loadState(config.worldDir, turnLogger) };
        } catch (err) {
          turnLogger.warn({ err }, "轉場後 loadState 失敗，done.state 保留轉場前快照");
        }
      }

      if (done.suggestedActions.length === 0) {
        done = { ...done, suggestedActions: ["順勢而為"] };
      }

      if (state.currentTurnBuffer) {
        state.currentTurnBuffer.events.push(done);
        state.currentTurnBuffer.active = false;
      }
      reply.raw.write(`data: ${JSON.stringify(done)}\n\n`);

      turnLogger.info({ durationMs: Date.now() - startedAt }, "/api/turn 完成");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      turnLogger.error({ err, durationMs: Date.now() - startedAt }, "/api/turn 失敗");
      const warnEv: TurnEvent = { type: "warning", message };
      if (state.currentTurnBuffer) state.currentTurnBuffer.events.push(warnEv);
      reply.raw.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } finally {
      state.turnInProgress = false;
      if (state.currentTurnBuffer?.active) {
        state.currentTurnBuffer.active = false;
      }
      reply.raw.end();
    }
  });
}
