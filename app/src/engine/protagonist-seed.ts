/**
 * 主角生成種子。所有欄位皆 optional——未填欄位交給 LLM 自由發揮（見 buildProtagonistPrompt）。
 * build 欄位是未來「天賦/屬性點數分配」設定頁的擴充位，現階段不會被任何呼叫端填值。
 */
export interface ProtagonistSeed {
  name?: string;
  /** 出身、性格、目標等自由描述（合併原 origin/freeform 兩欄） */
  freeform?: string;
  build?: ProtagonistBuild;
}

/** 預留型別：未來獨立的「隱藏分數 → 天賦/屬性選擇」設定頁產出，現在純粹卡位。 */
export interface ProtagonistBuild {
  hiddenScore?: number;
  talents?: string[];
  attributeAllocations?: Record<string, number>;
}

const UNSPECIFIED = "（使用者未指定，由你自由發揮一個符合世界基調的設定）";

/**
 * 把 seed 組成生成 protagonist.md 用的 user prompt 片段。
 * 未填欄位以「由你自由發揮」提示取代，讓 LLM 自行補齊，呼叫端不需做預設值補齊。
 * 現在只用 name/freeform；未來支援 build 時只在這裡加分支，呼叫端不必改。
 */
export function buildProtagonistPrompt(seed: ProtagonistSeed): string {
  const name = seed.name?.trim() || UNSPECIFIED;
  const freeform = seed.freeform?.trim() || UNSPECIFIED;
  return [
    "請依下列玩家設定，生成主角檔案 protagonist.md（繁體中文）：",
    `- 姓名：${name}`,
    `- 描述（出身、進入無限恐怖的原因、性格、目標等，玩家自由填寫）：${freeform}`,
  ].join("\n");
}
