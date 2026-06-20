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
 * 從副大腦原始輸出抽出 JSON 物件字串。
 * 先去掉 markdown code fence，再從第一個 `{` 起，由最後一個 `}` 往前逐個嘗試
 * 解析，取第一個能 JSON.parse 成功的範圍。這樣對「合法 JSON 之後又跟了含 `}`
 * 的客套字」（lastIndexOf 會抓到後綴的 `}`）也能還原，而非整段降級。
 * 找不到任何可解析的 JSON 時回傳 null。
 */
function extractJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) return null;

  // 由最後一個 `}` 往前找，第一個能成功 parse 的就是答案（happy path 一次命中）
  for (let end = cleaned.lastIndexOf("}"); end > start; end = cleaned.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // 這個 `}` 不是 JSON 真正的結尾（可能是後綴客套字裡的），往前再試
    }
  }
  return null;
}

/**
 * 從副大腦原始輸出解析出 TurnControl。
 * 副大腦只負責輸出結構，整段視為一個 JSON 物件（無 sentinel）。
 * 找不到可解析的 JSON / schema 不符都拋錯（由呼叫端決定降級）。
 */
export function parseControlOutput(raw: string): TurnControl {
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    throw new Error("副大腦輸出找不到可解析的 JSON 物件");
  }
  return TurnControlSchema.parse(parsed);
}
