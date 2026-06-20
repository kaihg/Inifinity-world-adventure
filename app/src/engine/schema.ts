import { z } from "zod";
import { STATE_SENTINEL } from "./stream-split.js";

/** now.md 七欄的可選覆寫（最後更新由引擎管理，不由模型給） */
const stringCoerce = z.preprocess((val) => {
  if (val === null || val === undefined) return "";
  if (Array.isArray(val)) return val.join(", ");
  return String(val);
}, z.string());

const NowChangesSchema = z
  .object({
    chapter: stringCoerce,
    scene: stringCoerce,
    companions: stringCoerce,
    activeDungeon: stringCoerce,
    threads: stringCoerce,
    nextStep: stringCoerce,
  })
  .partial();

const ProtagonistUpdatesSchema = z
  .object({
    attributes: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    items: z.array(z.string()).optional(),
    buffs: z.array(z.string()).optional(),
  })
  .optional();

const StateChangesSchema = z
  .object({
    protagonist_points_delta: z.number().optional(),
    protagonist_updates: ProtagonistUpdatesSchema,
    npc_updates: z.array(z.object({ id: z.string(), update: z.string() })).optional(),
    wiki_reveals: z.array(z.string()).optional(),
    item_pickups: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    item_reveals: z.array(z.object({ id: z.string(), reveal: z.string() })).optional(),
    now: NowChangesSchema.optional(),
  })
  .default({});

const RollReportSchema = z.object({
  desc: z.string(),
  value: z.number(),
  success: z.boolean().optional(),
});

/** 模型每回合輸出的結構化控制區塊（敘事散文不在此，走串流） */
export const TurnControlSchema = z.object({
  state_changes: StateChangesSchema,
  rolls: z.array(RollReportSchema).default([]),
  mode_transition: z.enum(["enter_dungeon", "settle_dungeon"]).nullable().default(null),
  /** 配合 mode_transition=enter_dungeon：要進入的副本 id（短 slug） */
  transition_dungeon_id: z.string().nullable().optional(),
  /** 配合 enter_dungeon：本次副本目標（可選） */
  transition_dungeon_goal: z.string().nullable().optional(),
  awaiting_user_input: z.boolean(),
  suggested_actions: z.array(z.string()).default([]),
  commit_summary: z.string().min(1),
});

export type TurnControl = z.infer<typeof TurnControlSchema>;
export type NowChanges = z.infer<typeof NowChangesSchema>;

export interface ParsedTurn {
  narrative: string;
  control: TurnControl;
}

/**
 * 從完整模型輸出拆出敘事與控制區塊：
 * sentinel 前為敘事散文，sentinel 後為單一 JSON 物件。
 * 缺 sentinel / JSON 非法 / schema 不符都拋錯（由呼叫端決定重試或降級）。
 */
export function parseTurnOutput(full: string): ParsedTurn {
  const idx = full.indexOf(STATE_SENTINEL);
  if (idx === -1) {
    throw new Error("模型輸出缺少 ===STATE=== 控制區塊");
  }
  const narrative = full.slice(0, idx).trim();
  const tail = full.slice(idx + STATE_SENTINEL.length);

  const start = tail.indexOf("{");
  const end = tail.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("控制區塊找不到 JSON 物件");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(tail.slice(start, end + 1));
  } catch (e) {
    throw new Error(`控制區塊 JSON 解析失敗：${(e as Error).message}`);
  }

  const control = TurnControlSchema.parse(raw);
  return { narrative, control };
}
