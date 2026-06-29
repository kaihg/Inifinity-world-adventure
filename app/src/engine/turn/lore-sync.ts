import { z } from "zod";
import { extractJsonObject } from "../schema.js";
import type { Logger } from "../../logger.js";
import { runIngest } from "../ingest.js";
import type { PendingLoreSync, TurnDeps, TurnPlan } from "./types.js";

// ---------------------------------------------------------------------------
// Layer 3 Local Schema
// parseLoreSyncOutput is exported for use in schema.test.ts
// ---------------------------------------------------------------------------

const LoreEntityRefSchema = z.object({
  id: z.string(),
  category: z.enum(["npc", "item", "scene", "skill"]),
  name: z.string(),
  excerpt: z.string(),
});

const LoreStateChangesSchema = z
  .object({
    touched_entities: z.array(LoreEntityRefSchema).optional(),
    dungeon_wiki_excerpt: z.string().optional(),
  })
  .default({});

const LoreSyncSchema = z.object({
  state_changes: LoreStateChangesSchema,
});

export type LoreSync = z.infer<typeof LoreSyncSchema>;

/** Layer 3 原始輸出解析（rules 同 parseFastControlOutput） */
export function parseLoreSyncOutput(raw: string): LoreSync {
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    throw new Error("Layer 3 reactive-lore-sync 輸出找不到可解析的 JSON 物件");
  }
  return LoreSyncSchema.parse(parsed);
}

/**
 * 把一個 Layer 3 任務包裝進 pendingLoreSync handle：保證 handle.promise 永遠 resolve
 * （任務內部已自行 catch，這裡只是雙重保險，避免下一回合開始時的 await 意外拋錯）。
 */
export function trackLoreSync(handle: PendingLoreSync, task: Promise<void>, log: Logger): void {
  handle.promise = task.catch((err) => {
    log.warn({ err }, "Layer 3 reactive-lore-sync 任務本身拋錯，已攔截，不影響下一回合");
  });
}

/**
 * Layer 3（reactive-lore-sync）：呼叫 runIngest 管線完成知識庫更新。
 * 不卡玩家可見的 done event；失敗只 log.warn，永遠不拋錯。
 */
export async function runLoreSync(
  deps: TurnDeps,
  narrative: string,
  settingText: string,
  _plan: TurnPlan,
  log: Logger,
): Promise<void> {
  try {
    await runIngest(deps, narrative, settingText, log);
  } catch (err) {
    log.warn({ err }, "Layer 3 ingest 失敗，本回合 lore 文件可能未完整補上");
  }
}

/**
 * 回合結束後啟動 Layer 3（不 await，讓回合本身立即結束）；有 pendingLoreSync handle 時
 * 接力寫回 handle，下一回合開始前會等它；沒有 handle（如未接線的舊呼叫端）則同步 await，
 * 維持「回合即時落地」的舊保證。
 */
export function scheduleLoreSync(
  deps: TurnDeps,
  narrative: string,
  settingText: string,
  plan: TurnPlan,
  log: Logger,
): Promise<void> {
  const task = runLoreSync(deps, narrative, settingText, plan, log);
  if (deps.pendingLoreSync) {
    trackLoreSync(deps.pendingLoreSync, task, log);
    return Promise.resolve();
  }
  return task;
}
