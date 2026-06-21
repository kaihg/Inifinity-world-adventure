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
    location_pickups: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    location_reveals: z.array(z.object({ id: z.string(), reveal: z.string() })).optional(),
    skill_pickups: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    skill_reveals: z.array(z.object({ id: z.string(), reveal: z.string() })).optional(),
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

/** Layer 2（fast-control）：done event 與 now/主角/commit 所需的最小欄位子集 */
const FastStateChangesSchema = z
  .object({
    protagonist_points_delta: z.number().optional(),
    protagonist_updates: ProtagonistUpdatesSchema,
    now: NowChangesSchema.optional(),
  })
  .default({});

export const FastControlSchema = z.object({
  state_changes: FastStateChangesSchema,
  rolls: z.array(RollReportSchema).default([]),
  mode_transition: z.enum(["enter_dungeon", "settle_dungeon"]).nullable().default(null),
  transition_dungeon_id: z.string().nullable().optional(),
  transition_dungeon_goal: z.string().nullable().optional(),
  awaiting_user_input: z.boolean(),
  suggested_actions: z.array(z.string()).default([]),
  commit_summary: z.string().min(1),
});

export type FastControl = z.infer<typeof FastControlSchema>;

/** Layer 3（reactive-lore-sync）：npc/item/location/skill/wiki 揭露相關欄位，皆可省略 */
const LoreStateChangesSchema = z
  .object({
    npc_updates: z.array(z.object({ id: z.string(), update: z.string() })).optional(),
    wiki_reveals: z.array(z.string()).optional(),
    item_pickups: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    item_reveals: z.array(z.object({ id: z.string(), reveal: z.string() })).optional(),
    location_pickups: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    location_reveals: z.array(z.object({ id: z.string(), reveal: z.string() })).optional(),
    skill_pickups: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    skill_reveals: z.array(z.object({ id: z.string(), reveal: z.string() })).optional(),
  })
  .default({});

export const LoreSyncSchema = z.object({
  state_changes: LoreStateChangesSchema,
});

export type LoreSync = z.infer<typeof LoreSyncSchema>;

/**
 * 從第一個 `{` 起，由最後一個 `}` 往前逐個嘗試解析，取第一個能 JSON.parse
 * 成功的範圍。這樣對「合法 JSON 之後又跟了含 `}` 的客套字」（lastIndexOf 會
 * 抓到後綴的 `}`）也能還原，而非整段降級。找不到任何可解析的範圍時回傳
 * undefined（與 JSON 合法值 null 區分）。
 */
function extractFromText(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // 這個 `}` 不是 JSON 真正的結尾（可能是後綴客套字裡的），往前再試
    }
  }
  return undefined;
}

/**
 * 從副大腦原始輸出抽出 JSON 物件字串。
 * 先去掉 markdown code fence直接嘗試解析；只有直接解析失敗時，才進一步補
 * 修常見的 LLM 格式錯誤（無引號鍵、單引號鍵）後重試 —— 修復用正則不理解
 * 字串邊界，若對本來就合法的 JSON 全文套用，字串值裡剛好出現「, 詞:」
 * 這種片段（例如 commit_summary 的敘事文字）會被誤判成未加引號的鍵而破壞，
 * 所以只在 happy path 失敗時才介入，避免讓本來能解析的輸出反而解析失敗。
 * 找不到任何可解析的 JSON 時回傳 null。
 */
function extractJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, "");

  const direct = extractFromText(cleaned);
  if (direct !== undefined) return direct;

  const keysPattern = "state_changes|rolls|mode_transition|transition_dungeon_id|transition_dungeon_goal|awaiting_user_input|suggested_actions|commit_summary|protagonist_points_delta|protagonist_updates|npc_updates|wiki_reveals|item_pickups|item_reveals|location_pickups|location_reveals|skill_pickups|skill_reveals|now|chapter|scene|companions|activeDungeon|threads|nextStep|desc|value|success|id|name|update|reveal|attributes|skills|items|buffs";

  const repaired = cleaned
    // 1. 將無引號的鍵補上雙引號 (例如 { desc: -> { "desc": )
    .replace(new RegExp(`([{,]\\s*)(${keysPattern})\\s*:`, 'g'), '$1"$2":')
    // 2. 將單引號的鍵改為雙引號 (例如 { 'desc': -> { "desc": )
    .replace(new RegExp(`([{,]\\s*)'(${keysPattern})'\\s*:`, 'g'), '$1"$2":')
    // 3. 將缺少左引號的鍵補齊 (例如 { desc": -> { "desc": )
    .replace(new RegExp(`([{,]\\s*)(${keysPattern})"\\s*:`, 'g'), '$1"$2":')
    // 4. 將缺少右引號的鍵補齊 (例如 { "desc: -> { "desc": )
    .replace(new RegExp(`([{,]\\s*)"(${keysPattern})\\s*:`, 'g'), '$1"$2":');

  const fallback = extractFromText(repaired);
  return fallback === undefined ? null : fallback;
}

/**
 * 從副大腦原始輸出解析出 TurnControl。
 * 副大腦只負責輸出結構，整段視為一個 JSON 物件（無 sentinel）。
 * 找不到可解析的 JSON / schema 不符都拋錯（由呼叫端決定降級）。
 */
/**
 * 在送入 Zod 驗證前，對已解析的 JSON 物件進行強健性預處理。
 * 1. 提升（Hoisting）：若副大腦不小心將頂層控制欄位巢狀寫進了 state_changes 內部，自動提昇至頂層。
 * 2. 清理（Null-Cleanup）：刪除 state_changes 中值為 null 的選填欄位，防範小模型輸出 "protagonist_updates": null 造成 Zod 報錯。
 */
function preprocessControlParsed(parsed: unknown): unknown {
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, any>;
    const stateChanges = obj.state_changes;
    if (typeof stateChanges === "object" && stateChanges !== null && !Array.isArray(stateChanges)) {
      // 1. 提升
      const keysToHoist = Object.keys(TurnControlSchema.shape).filter((key) => key !== "state_changes");
      for (const key of keysToHoist) {
        if (obj[key] === undefined && stateChanges[key] !== undefined) {
          obj[key] = stateChanges[key];
          delete stateChanges[key];
        }
      }

      // 2. 清理 null
      for (const key of Object.keys(stateChanges)) {
        if (stateChanges[key] === null) {
          delete stateChanges[key];
        }
      }
    }
  }
  return parsed;
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
  return TurnControlSchema.parse(preprocessControlParsed(parsed));
}

/** 從 Layer 2（fast-control）原始輸出解析出 FastControl，規則同 parseControlOutput */
export function parseFastControlOutput(raw: string): FastControl {
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    throw new Error("Layer 2 fast-control 輸出找不到可解析的 JSON 物件");
  }
  return FastControlSchema.parse(preprocessControlParsed(parsed));
}

/** 從 Layer 3（reactive-lore-sync）原始輸出解析出 LoreSync，規則同 parseControlOutput */
export function parseLoreSyncOutput(raw: string): LoreSync {
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    throw new Error("Layer 3 reactive-lore-sync 輸出找不到可解析的 JSON 物件");
  }
  return LoreSyncSchema.parse(preprocessControlParsed(parsed));
}
