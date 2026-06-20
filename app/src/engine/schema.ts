import { z } from "zod";

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

/**
 * 從副大腦原始輸出解析出 TurnControl。
 * 副大腦只負責輸出結構，整段視為一個 JSON 物件（無 sentinel）；
 * 為容忍模型偶爾前後加客套字，抓第一個 `{` 到最後一個 `}` 之間當 JSON。
 * 找不到 JSON / JSON 非法 / schema 不符都拋錯（由呼叫端決定降級）。
 */
export function parseControlOutput(raw: string): TurnControl {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("副大腦輸出找不到 JSON 物件");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`副大腦輸出 JSON 解析失敗：${(e as Error).message}`);
  }

  return TurnControlSchema.parse(parsed);
}
