import { z } from "zod";

/** now.md 七欄的可選覆寫（最後更新由引擎管理，不由模型給） */
const stringCoerce = z.preprocess((val) => {
  if (val === null || val === undefined) return "";
  if (Array.isArray(val)) return val.join(", ");
  return String(val);
}, z.string());

/**
 * 7B 偶發把「沒有值」的欄位吐成字串 "null"/"none"/"undefined"（而非 JSON null），
 * 害 .nullable() 驗證失敗、整個 fast-control 解析降級。落地前先把這些哨兵字串
 * 正規化成真 null，再交給下游 schema 驗證。包住既有 schema，保留其原本的型別檢查。
 */
const NULLISH_STRINGS = new Set(["null", "none", "undefined", "nil", "n/a", ""]);
function nullishStringCoerce<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => {
    if (typeof val === "string" && NULLISH_STRINGS.has(val.trim().toLowerCase())) return null;
    return val;
  }, schema);
}

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

const RollReportSchema = z.object({
  desc: z.string(),
  value: z.number(),
  success: z.boolean().optional(),
});

export type NowChanges = z.infer<typeof NowChangesSchema>;

/** Layer 2（fast-control）：done event 與 now/commit 所需的最小欄位子集 */
const FastStateChangesSchema = z
  .object({
    now: NowChangesSchema.optional(),
  })
  .default({});

export const FastControlSchema = z.object({
  state_changes: FastStateChangesSchema,
  rolls: z.array(RollReportSchema).default([]),
  mode_transition: nullishStringCoerce(
    z.enum(["enter_dungeon", "settle_dungeon"]).nullable().default(null),
  ),
  transition_dungeon_id: nullishStringCoerce(z.string().nullable().optional()),
  transition_dungeon_goal: nullishStringCoerce(z.string().nullable().optional()),
  awaiting_user_input: z.boolean(),
  protagonist_permanent_death: z.boolean().default(false),
  suggested_actions: z.array(z.string()).default([]),
  commit_summary: z.string().min(1),
});

export type FastControl = z.infer<typeof FastControlSchema>;

/** Layer 3（reactive-lore-sync）：本回合摸到的實體列表 + 副本本身的揭露片段，皆可省略 */
const LoreEntityRefSchema = z.object({
  id: z.string(),
  category: z.enum(["npc", "item", "location", "skill"]),
  name: z.string(),
  excerpt: z.string(),
});

export type LoreEntityRef = z.infer<typeof LoreEntityRefSchema>;

const LoreStateChangesSchema = z
  .object({
    touched_entities: z.array(LoreEntityRefSchema).optional(),
    dungeon_wiki_excerpt: z.string().optional(),
    protagonist_points_delta: z.number().optional(),
    protagonist_changed: z.boolean().default(false),
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

  const repaired = cleaned
    // 1. 將無引號的鍵補上雙引號 (例如 { desc: -> { "desc": )
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    // 2. 將單引號的鍵改為雙引號 (例如 { 'desc': -> { "desc": )
    .replace(/([{,]\s*)'([a-zA-Z_][a-zA-Z0-9_]*)'\s*:/g, '$1"$2":');

  const fallback = extractFromText(repaired);
  return fallback === undefined ? null : fallback;
}

/**
 * 從 Layer 2（fast-control）原始輸出解析出 FastControl。
 * 副大腦只負責輸出結構，整段視為一個 JSON 物件（無 sentinel）。
 * 找不到可解析的 JSON / schema 不符都拋錯（由呼叫端決定降級）。
 */
export function parseFastControlOutput(raw: string): FastControl {
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    throw new Error("Layer 2 fast-control 輸出找不到可解析的 JSON 物件");
  }
  return FastControlSchema.parse(parsed);
}

/** 從 Layer 3（reactive-lore-sync）原始輸出解析出 LoreSync，規則同 parseFastControlOutput */
export function parseLoreSyncOutput(raw: string): LoreSync {
  const parsed = extractJsonObject(raw);
  if (parsed === null) {
    throw new Error("Layer 3 reactive-lore-sync 輸出找不到可解析的 JSON 物件");
  }
  return LoreSyncSchema.parse(parsed);
}
