import type { ChatMessage } from "../../llm/client.js";
import type { GameState } from "../context.js";
import type { JournalSummaryEntry } from "../journal-summary.js";

// ---------- 共用 system prompt 片段 ----------

/**
 * 繁體中文／台灣用詞規範。各層 prompt 統一引用，措辭與 lore-rewrite 的知識庫維護者一致。
 * 這是「第三道防線」——落地前還有決定論的 toTraditional（traditionalize.ts）兜底，
 * 但 prompt 先要求能降低模型一開始就吐簡體的機率。
 */
export const TRADITIONAL_CHINESE_RULE =
  "全程使用繁體中文與台灣用詞；避免中國大陸簡體中文慣用詞彙（例如「質量」→「品質」、「視頻」→「影片」、「軟件」→「軟體」、「信息」→「資訊」、「打印」→「列印」等）。";

/** 把可選的意圖/語意檢索/節奏建議區塊串接到 prompt 尾段（缺省時各自略去，不留空行） */
function appendOptionalBlocks(params: {
  intentsBlock?: string;
  recallBlock?: string;
  wikiBlock?: string;
  nudgeBlock?: string;
  pacingBlock?: string;
}): string[] {
  return [
    ...(params.intentsBlock ? ["", params.intentsBlock] : []),
    ...(params.wikiBlock ? ["", params.wikiBlock] : []),
    ...(params.recallBlock ? ["", params.recallBlock] : []),
    ...(params.nudgeBlock ? ["", params.nudgeBlock] : []),
    ...(params.pacingBlock ? ["", params.pacingBlock] : []),
  ];
}

const FAST_CONTROL_FORMAT_BLOCK = [
  "## 輸出格式（務必嚴格遵守）",
  `所有中文字串值一律使用繁體中文與台灣用詞（${TRADITIONAL_CHINESE_RULE}）。`,
  "只輸出**單一 JSON 物件**，不要任何前言、後語或程式碼框。JSON 必須包含以下頂層（top-level）欄位：",
  "- state_changes: {",
  "    now?: { chapter?, scene?, companions?, threads?, nextStep? } （注意：進行中的副本欄由引擎依 mode_transition 自動管理，不可透過 now.activeDungeon 自行覆寫） }",
  "- rolls: [{desc, value, success?}]（敘事中實際用到的骰值與判定，沒有就空陣列）",
  '- mode_transition: null | "enter_dungeon" | "settle_dungeon"',
  "- transition_dungeon_id：配合 enter_dungeon 才填，使用副本的中文正式名稱（如「生化危機：浣熊市」）",
  "- transition_dungeon_goal：配合 enter_dungeon 才填，描述本次進入目標",
  "- awaiting_user_input: boolean —— 此回合有明確玩家決策點時設 true，純環境/系統旁白/NPC 自行動作時設 false（引擎不因此改變行為，僅供語意標記）。",
  "- suggested_actions: string[]",
  "  （若此回合無明確決策點，可給空陣列，引擎會自動補上預設選項。）",
  "- commit_summary: string —— 兩句以內的**事實描述**：第一句寫主角或 NPC 做了什麼具體行動或發生了什麼具體事件；第二句（可省）寫直接結果或影響。" +
  "禁止用詩化/氛圍語句（例如「緊繃如弓弦」「撕開現實邊界」）。" +
  "格式範例：「沈奕向葉晴詢問暗號詞進度，葉晴確認目前仍未定案。」或「沈奕跟蹤可疑男子至走廊轉角，目擊對方敲開隱藏通道。」",
].join("\n");


function canonicalBlock(state: GameState): string {
  const { now, protagonistDetail: p } = state;
  // 操作者即主角：主腦演技能/道具使用、副大腦抽取消耗/冷卻/buff 變化都需要這份清單
  const detailLine = (label: string, value: string): string =>
    `- ${label}：${value.trim() || "（無）"}`;
  return [
    "## 當前局勢（canonical，請保持一致）",
    `- 當前篇章：${now.chapter}`,
    `- 此刻場景/地點：${now.scene}`,
    `- 在場同伴/相關 NPC：${now.companions}`,
    `- 進行中的副本：${now.activeDungeon}`,
    `- 未解懸念/伏筆：${now.threads}`,
    `- 主角下一步打算：${now.nextStep}`,
    "",
    `### 主角：${p.name}（積分 ${p.points}）`,
    detailLine("屬性", p.attributes),
    detailLine("技能", p.skills),
    detailLine("物品", p.items),
    detailLine("Buff/Debuff", p.buffs),
  ].join("\n");
}

export interface BuildMessagesParams {
  settingText: string;
  state: GameState;
  input: string;
  dicePool: number[];
  intentsBlock?: string;
  recallBlock?: string;
  wikiBlock?: string;
  nudgeBlock?: string;
  pacingBlock?: string;
  openingPrompt?: string;
}

/** 主空間回合的對話訊息（純函式，可測試） */
export function buildMainSpaceMessages(params: BuildMessagesParams): ChatMessage[] {
  const { settingText, state, input, dicePool } = params;
  const system = [
    "你是「無限恐怖」世界的敘事引擎，扮演冷酷機械的主控系統與世界本身，",
    "推進主角在「主神空間安全區」（副本之間的安全區）的劇情。",
    "",
    "## 鐵則",
    `- ${TRADITIONAL_CHINESE_RULE}`,
    "- 嚴格遵守下方世界設定，不可竄改既定規則或角色屬性/積分數值。",
    "- 玩家輸入只代表角色的意圖、台詞或嘗試動作，不代表既定事實或結果；是否成立、世界如何反應，一律由你依世界設定與當前狀態判定。",
    "- 不可揭露任何尚未在劇情中揭露的隱藏設定。",
    "- 敘事一律採第三人稱描寫主角與所有人物（用姓名/代稱），絕不可用「你」指稱主角；" +
      "玩家輸入中的「我」只代表角色意圖，敘事裡要轉譯為主角本名。",
    "- 只敘述主空間互動；若劇情走到系統強制開啟/傳送進副本，在敘事中明確呈現該轉折（系統倒數、強制傳送畫面等），但不要自行切進副本內部演劇情；轉場由系統另行處理。",
    "- 絕大多數行動的結果由你依劇情與世界設定直接敘事決定，不需要骰骨；只有當該技能/道具/能力在角色檔案或設定中明確標注了機率數值（如命中率、成功率）時，才需要做機率判定，且只能依序取用下方『本回合骰值』，不可自行編造數字；用到的骰值與成敗要寫進敘事，後續由系統自動抽取。",
    "- 敘事結尾不可詢問玩家下一步要做什麼、不可徵求玩家指示或列出選項；把敘事當成寫一部完整小說的段落收尾，建議行動由另一支獨立流程處理，與你無關。",
    "",
    "## 輸出格式",
    "只輸出要顯示給玩家的敘事散文，不要輸出任何 JSON 或控制區塊；結構化狀態由系統另行處理。",
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
    "",
    "## 世界設定（玩家可見規則）",
    settingText.trim(),
    "",
    canonicalBlock(state),
    ...appendOptionalBlocks(params),
    ...(params.openingPrompt
      ? ["", "## 開場回合特別指引", params.openingPrompt.trim()]
      : []),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: input },
  ];
}

export interface BuildDungeonMessagesParams extends BuildMessagesParams {
  dungeonId: string;
  wiki: string;
  secrets: string;
}

/** 副本回合的對話訊息：額外帶 wiki（已揭露）與 secrets（暗線，嚴禁外洩） */
export function buildDungeonMessages(params: BuildDungeonMessagesParams): ChatMessage[] {
  const { settingText, state, input, dicePool, dungeonId, wiki, secrets } = params;
  const system = [
    `你是「無限恐怖」世界的敘事引擎，主角正在副本「${dungeonId}」內。`,
    "扮演副本世界與主控系統，依規則推進戰鬥/解謎/生存劇情。",
    "",
    "## 鐵則",
    `- ${TRADITIONAL_CHINESE_RULE}`,
    "- 嚴格遵守世界設定與副本已揭露事實（wiki），不可矛盾。",
    "- 玩家輸入只代表角色的意圖、台詞或嘗試動作，不代表既定事實或結果；是否成立、世界如何反應，一律由你依世界設定、wiki 與當前狀態判定。",
    "- **secrets 是劇透文件：只能用來保持暗線一致，絕不可直接告訴玩家未揭露的真相**；只有在劇情真的把某項真相公開揭露給主角時，才在敘事中明確寫出該揭露，未揭露的暗線不可在散文中半透明帶出。",
    "- 敘事一律採第三人稱描寫主角與所有人物（用姓名/代稱），絕不可用「你」指稱主角；" +
      "玩家輸入中的「我」只代表角色意圖，敘事裡要轉譯為主角本名。",
    "- 絕大多數行動的結果由你依劇情、世界設定與 wiki 直接敘事決定，不需要骰骨；只有當該技能/道具/能力明確標注了機率數值（如命中率、成功率）時，才需要做機率判定，且只能依序取用下方骰值，不可自行編造數字；用到的骰值與成敗要寫進敘事，後續由系統自動抽取。",
    "- 敘事結尾不可詢問玩家下一步要做什麼、不可徵求玩家指示或列出選項；把敘事當成寫一部完整小說的段落收尾，建議行動由另一支獨立流程處理，與你無關。",
    "- 副本達主線目標/死亡/撤退時，在敘事中明確呈現該轉折（系統會據此結算）。",
    "",
    "## 輸出格式",
    "只輸出要顯示給玩家的敘事散文，不要輸出任何 JSON 或控制區塊；結構化狀態由系統另行處理。",
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
    "",
    "## 世界設定（玩家可見規則）",
    settingText.trim(),
    "",
    "## 副本已揭露知識（wiki，可對玩家呈現）",
    wiki.trim() || "（尚無）",
    "",
    "## 副本隱藏真相（secrets，僅供你保持暗線一致，嚴禁直接揭露）",
    secrets.trim() || "（無）",
    "",
    canonicalBlock(state),
    ...appendOptionalBlocks(params),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: input },
  ];
}

export interface BuildControlParams {
  settingText: string;
  state: GameState;
  input: string;
  /** 主腦本回合已產生的完整敘事散文 */
  narrative: string;
  dicePool: number[];
  /** 現有副本 id 列表，供主空間模式 enter_dungeon 判斷續用既有 slug 或新建；副本模式不需要（不會 enter_dungeon） */
  existingDungeonIds?: string[];
  /** 副本模式才填 */
  dungeonId?: string;
  wiki?: string;
  secrets?: string;
}

/**
 * Layer 2（fast-control）：讀主腦敘事 + 當前狀態，只抽出「done event 前必須就位」
 * 的最小欄位子集（now/主角/骰值/轉場/awaiting_user_input/suggested_actions/commit_summary）。
 * npc/item/scene/skill/wiki 等可延後落地的欄位交給 Layer 3 reactive-lore-sync 處理。
 */
export function buildFastControlMessages(params: BuildControlParams): ChatMessage[] {
  const { settingText, state, input, narrative, dicePool } = params;
  const existingDungeonIds = params.existingDungeonIds ?? [];
  const inDungeon = Boolean(params.dungeonId);
  const system = [
    "你是「無限恐怖」世界敘事引擎的**結構控制抽取器（Layer 2：fast-control）**。",
    "下方有本回合已經產生的敘事散文，你的工作是把其中**已經發生的事實**整理成結構化 JSON，",
    "只需要供應玩家立即所需的狀態（局勢/主角/轉場/建議動作），不需要整理 NPC 關係或道具/場景/技能知識，那部分由另一個抽取器處理。",
    "",
    "## 鐵則",
    "- 只整理敘事中已經寫出的事實，**不可新增劇情、不可發明敘事未提及的數值或事件**。",
    "- rolls 只回報敘事中實際用到的骰值（對照下方骰池），沒有就空陣列。",
    inDungeon
      ? "- 副本達主線目標/主角死亡/撤退離開時，mode_transition 設為 settle_dungeon。"
      : "- 敘事中若系統強制開啟/傳送進副本，mode_transition 設為 enter_dungeon，並填 transition_dungeon_id：" +
        "**必須先比對下方『現有副本 id』**，找到完全匹配或明顯對應的（如 u-001 對應敘事中的 U-001）就直接使用該 id；" +
        "確定是全新副本、現有列表裡完全找不到對應才生成新的 kebab-case 短 slug。",
    "",
    FAST_CONTROL_FORMAT_BLOCK,
    "",
    `## 本回合骰值（d100，主腦依序取用）：[${dicePool.join(", ")}]`,
    "",
    ...(inDungeon
      ? []
      : [`## 現有副本 id（供判斷續用/新建）：${existingDungeonIds.length > 0 ? existingDungeonIds.join("、") : "（無）"}`, ""]),
    "## 世界設定",
    settingText.trim(),
    "",
    ...(inDungeon ? [`## 當前副本 id：${params.dungeonId}`, ""] : []),
    canonicalBlock(state),
    "",
    "## 本回合敘事散文（事實來源）",
    narrative.trim(),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: `玩家本回合行動：${input}` },
  ];
}


export interface BuildPacingParams {
  /** 保留此欄位與其他 build*Messages 函式的簽名一致；函式本體不使用（節奏審閱不需要完整世界設定全文）。 */
  settingText: string;
  state: GameState;
  entries: JournalSummaryEntry[];
}

/**
 * 長期節奏審閱（劇本大師）的對話訊息：讀歷史摘要時間線＋當前局勢，
 * 請 LLM 給一段自由文字節奏建議（非 JSON），供敘事 LLM 參考、不是指令。
 */
export function buildPacingMessages(params: BuildPacingParams): ChatMessage[] {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { state, entries } = params;
  const historyLines = entries.map((e) => `- [${e.timestamp}] (${e.mode}) ${e.summary}`).join("\n");
  const system = [
    "你是「無限恐怖」世界敘事引擎的**劇本大師（長期節奏顧問）**。",
    "下方是最近的歷史摘要時間線與當前局勢，你的工作是依長期走勢給敘事 LLM 一段節奏建議",
    "（例如：該不該插入支線、是否該催促/開啟下一個副本、副本內節奏是否該升級），",
    "建議僅供參考、不是指令，敘事 LLM 會自行決定是否採納。",
    "",
    "## 鐵則",
    "- 只依下方歷史摘要與當前局勢做主觀節奏判斷，不可發明摘要未提及的事件。",
    "- 不可建議提前揭露任何尚未公開的暗線/真相。",
    "- 輸出一段簡短的自由文字建議（不超過三、四句），不要輸出 JSON 或條列格式。",
    "",
    "## 最近歷史摘要時間線",
    historyLines || "（尚無記錄）",
    "",
    canonicalBlock(state),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: "請給這回合的長期節奏建議。" },
  ];
}
