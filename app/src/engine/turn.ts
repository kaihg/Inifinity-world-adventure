import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { logger as defaultLogger, type Logger } from "../logger.js";
import {
  loadState,
  parseNow,
  parseProtagonist,
  applyPointsDelta,
  applyProtagonistUpdates,
  rewriteNpcFile,
  addCharacterIndexRow,
  applyIndexStatusUpdates,
  NPC_ID_RE,
  type GameState,
} from "./context.js";
import { summarizeNpcStatus } from "./npc-status-summary.js";
import { appendJournal } from "./journal.js";
import { applyNowChanges, serializeNow, bumpNowUpdated } from "./now.js";
import { rollPool } from "./roll.js";
import {
  parseFastControlOutput,
  parseLoreSyncOutput,
  type FastControl,
  type LoreEntityRef,
} from "./schema.js";
import {
  parseActiveDungeon,
  formatActiveDungeon,
  enterDungeon,
  appendRun,
  loadDungeonLore,
  listDungeonIds,
} from "./dungeon.js";
import { loadLore, ensureSecrets, rewriteLoreWiki, loreDir, type LoreCategory } from "./lore.js";
import {
  runCharacterPrePass,
  formatIntentsBlock,
  parseCompanionIds,
} from "./character-pre-pass.js";
import { formatRecallBlock } from "../recall/index.js";
import type { RecallIndex } from "../recall/store.js";

/**
 * Layer 3（reactive-lore-sync）的接力 handle：一個 process 內的 mutable promise 容器，
 * 不是真正的 lock，只是讓「下一回合開始前」可以 await 上一回合的 lore-sync 是否落地完。
 * `promise` 永遠保證 resolve（內部已 catch），不會讓 await 端拋錯。
 */
export interface PendingLoreSync {
  promise: Promise<void> | null;
}

export interface TurnDeps {
  client: LlmClient;
  characterClient?: LlmClient;
  /** 結構控制抽取 LLM（副大腦）；未提供時退回 deps.client */
  controlClient?: LlmClient;
  /** Layer 3 reactive-lore-sync 用的 LLM；未提供時依序退回 controlClient、client */
  loreClient?: LlmClient;
  worldDir: string;
  commit: (message: string) => Promise<boolean>;
  today?: () => string;
  /** 本回合預擲骰池（測試可注入；預設 crypto 真隨機 6 顆 d100） */
  dicePool?: number[];
  /** 未提供時退回共用的預設 logger（測試環境下為 silent） */
  logger?: Logger;
  /** 語意檢索索引（選填；缺省時跳過檢索，不影響既有回合流程） */
  recall?: RecallIndex;
  /** 每回合檢索片段數上限，預設 5 */
  recallTopK?: number;
  /**
   * Layer 3 接力 handle（選填）。提供時，本回合的 lore-sync 不 await 完成即讓回合結束
   * （done event 立即送出），handle.promise 會被換成本回合的 lore-sync；
   * 未提供時退回舊行為：lore-sync 與回合本身同步完成。
   */
  pendingLoreSync?: PendingLoreSync;
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "warning"; message: string }
  | { type: "auto-advance"; index: number }
  | { type: "transition"; to: "dungeon" | "main-space"; dungeonId?: string }
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: FastControl["mode_transition"];
      transitionDungeonId?: string;
      transitionDungeonGoal?: string;
    };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function deriveSummary(narrative: string): string {
  const firstLine = narrative.split("\n").find((l) => l.trim()) ?? "回合";
  const oneLine = firstLine.replace(/[#*>`]/g, "").trim();
  return oneLine.length > 40 ? oneLine.slice(0, 40) + "…" : oneLine;
}

async function readBestEffort(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

// ---------- 共用 system prompt 片段 ----------

/** 把可選的意圖區塊與語意檢索區塊串接到 prompt 尾段（兩者缺省時各自略去，不留空行） */
function appendOptionalBlocks(params: { intentsBlock?: string; recallBlock?: string }): string[] {
  return [
    ...(params.intentsBlock ? ["", params.intentsBlock] : []),
    ...(params.recallBlock ? ["", params.recallBlock] : []),
  ];
}

const FAST_CONTROL_FORMAT_BLOCK = [
  "## 輸出格式（務必嚴格遵守）",
  "只輸出**單一 JSON 物件**，不要任何前言、後語或程式碼框。JSON 必須包含以下頂層（top-level）欄位：",
  "- state_changes: {",
  "    now?: { chapter?, scene?, companions?, threads?, nextStep? }, （注意：進行中的副本欄由引擎依 mode_transition 自動管理，不可透過 now.activeDungeon 自行覆寫）",
  "    protagonist_points_delta?: number,",
  "    protagonist_updates?: { attributes?: string[], skills?: string[], items?: string[], buffs?: string[] }",
  "      （只填新增/變化的條目，會附加到對應區塊，不要重複列已有項目） }",
  "- rolls: [{desc, value, success?}]（敘事中實際用到的骰值與判定，沒有就空陣列）",
  '- mode_transition: null | "enter_dungeon" | "settle_dungeon"',
  "- transition_dungeon_id / transition_dungeon_goal：配合 enter_dungeon 才填",
  "- awaiting_user_input: boolean —— 敘事屬純環境/系統旁白/NPC 自行動作、玩家不需做決定時設 false；需要玩家選擇才設 true。",
  "- suggested_actions: string[]",
  "- commit_summary: string （一句摘要）",
].join("\n");

const LORE_SYNC_FORMAT_BLOCK = [
  "## 輸出格式（務必嚴格遵守）",
  "只輸出**單一 JSON 物件**，不要任何前言、後語或程式碼框。欄位：",
  "- state_changes: { touched_entities?: [{id, category, name, excerpt}], dungeon_wiki_excerpt?: string }",
  "  - touched_entities：本回合敘事中明確登場、或知識被進一步揭露/訂正的 NPC、道具、場景、技能。",
  "    category 只能是 npc/item/location/skill 其中之一；id 用英數小寫 slug；name 用顯示名稱；",
  "    excerpt 是本回合敘事中跟這個實體有關的原文片段（之後會有另一步驟拿這段片段去跟現有檔案比較、",
  "    決定怎麼更新，你不需要自己組好最終的完整內容，只要把相關原文片段填進來）。",
  "  - dungeon_wiki_excerpt：劇情中對**當前副本本身**新揭露的知識片段（地圖/機關/規則），不在副本中則省略。",
  "（本回合若沒有任何相關異動，對應欄位省略或留空陣列即可，不要硬湊內容）",
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
}

/** 主空間回合的對話訊息（純函式，可測試） */
export function buildMainSpaceMessages(params: BuildMessagesParams): ChatMessage[] {
  const { settingText, state, input, dicePool } = params;
  const system = [
    "你是「無限恐怖」世界的敘事引擎，扮演冷酷機械的主控系統與世界本身，",
    "推進主角在「主神空間安全區」（副本之間的安全區）的劇情。",
    "",
    "## 鐵則",
    "- 全程使用繁體中文與台灣用詞。",
    "- 嚴格遵守下方世界設定，不可竄改既定規則或角色屬性/積分數值。",
    "- 玩家輸入只代表角色的意圖、台詞或嘗試動作，不代表既定事實或結果；是否成立、世界如何反應，一律由你依世界設定與當前狀態判定。",
    "- 不可揭露任何尚未在劇情中揭露的隱藏設定。",
    "- 敘事一律採第三人稱描寫主角與所有人物（用姓名/代稱，例如「沈奕」「葉晴」），絕不可用「你」指稱主角；" +
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
    "- 全程使用繁體中文與台灣用詞。",
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
 * npc/item/location/skill/wiki 等可延後落地的欄位交給 buildLoreSyncMessages。
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
    "- protagonist_points_delta 只反映敘事中明確發生的積分增減；沒寫到就填 0 或省略。",
    "- rolls 只回報敘事中實際用到的骰值（對照下方骰池），沒有就空陣列。",
    inDungeon
      ? "- 副本達主線目標/主角死亡/撤退離開時，mode_transition 設為 settle_dungeon。"
      : "- 敘事中若系統強制開啟/傳送進副本，mode_transition 設為 enter_dungeon，並填 transition_dungeon_id：" +
        "優先比對下方『現有副本 id』判斷是否重返既有副本；若是全新副本才生成新的 kebab-case 短 slug。",
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

/**
 * Layer 3（reactive-lore-sync）：讀主腦敘事 + 當前狀態，抽出可延後落地的 lore 欄位
 * （npc_updates、item/location/skill 的 pickups 與 reveals、wiki_reveals）。不卡玩家可見的 done event，
 * 但仍只整理敘事中已發生的事實，規則與 Layer 2 一致。
 */
export function buildLoreSyncMessages(params: BuildControlParams): ChatMessage[] {
  const { settingText, state, input, narrative } = params;
  const inDungeon = Boolean(params.dungeonId);
  const system = [
    "你是「無限恐怖」世界敘事引擎的**結構控制抽取器（Layer 3：reactive-lore-sync）**。",
    "下方有本回合已經產生的敘事散文，你的工作是把其中**已經發生的事實**整理成結構化 JSON，",
    "只需要負責 NPC 關係、道具/場景/技能的初次接觸與知識揭露，不需要處理 now/主角積分/轉場等即時狀態，那部分已由另一個抽取器處理。",
    "",
    "## 鐵則",
    "- 只整理敘事中已經寫出的事實，**不可新增劇情、不可發明敘事未提及的事件**。",
    "- wiki_reveals / item_reveals / location_reveals / skill_reveals 只填**敘事中明確公開揭露給主角知道**的真相（角色已親眼確認、已被明說）；" +
      "敘事中模糊的暗示、伏筆、氣氛描寫一律不可當成已揭露填入，寧可漏填也不可提前洩漏暗線。",
    "",
    LORE_SYNC_FORMAT_BLOCK,
    "",
    "## 世界設定",
    settingText.trim(),
    "",
    ...(inDungeon
      ? ["## 副本已揭露知識（wiki）", (params.wiki ?? "").trim() || "（尚無）",
         "", `## 當前副本 id：${params.dungeonId}`, ""]
      : []),
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

/**
 * 把本回合有 touched 的 NPC id，用小模型（characterClient，缺省退回主 client）
 * 各自讀取（已被整檔重寫過的）最新角色檔摘要成一句近況，同步進 characters/index.md 的「最近狀態」欄。
 * 不用主敘事模型：這只是省 context 的索引摘要，不需要主敘事的推理力。
 * 單筆摘要失敗只略過該筆，不中斷其他筆、不影響回合本身。
 */
async function syncCharacterIndexStatus(
  deps: TurnDeps,
  npcIds: string[],
  log: Logger,
): Promise<void> {
  const summaryClient = deps.characterClient ?? deps.client;
  const entries = await Promise.all(
    npcIds.map(async (id): Promise<readonly [string, string] | null> => {
      const characterMd = await readBestEffort(path.join(deps.worldDir, "characters", `${id}.md`));
      if (!characterMd) return null;
      const name = parseProtagonist(characterMd).name || id;
      const status = await summarizeNpcStatus({ name, characterMd, client: summaryClient });
      return status ? [id, status] : null;
    }),
  );
  const statusUpdates = Object.fromEntries(
    entries.filter((e): e is readonly [string, string] => e !== null),
  );
  if (Object.keys(statusUpdates).length === 0) return;

  const indexPath = path.join(deps.worldDir, "characters", "index.md");
  const indexMd = await readBestEffort(indexPath);
  if (!indexMd) return;
  await writeFile(indexPath, applyIndexStatusUpdates(indexMd, statusUpdates), "utf8");
  log.debug({ statusUpdates }, "同步 characters/index.md 近況欄");
}

/** 防止路徑穿越：道具/場景/技能/副本 id 只允許英數字、連字號、底線、點（不含路徑分隔符） */
const ITEM_ID_RE = /^[\w.-]+$/;

/** 為指定道具生成隱藏設定（劇透文件，僅供暗線一致，不可外洩）；風格與 generateSecrets 對齊 */
async function generateItemSecrets(client: LlmClient, settingText: string, itemName: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的道具設計者。為指定道具生成隱藏設定（真實來歷、隱藏效果、與主線的關聯）。" +
        "這是劇透文件，玩家永遠不會直接看到，只供敘事暗線一致。只輸出設定內容本身，繁體中文，不要前言或客套。\n\n" +
        "世界設定：\n" + settingText.trim(),
    },
    { role: "user", content: `道具名稱：${itemName}。請生成其隱藏設定。` },
  ];
  let full = "";
  for await (const d of client.streamChat(messages)) full += d;
  return full.trim() || "（生成失敗，待補）";
}

const ENTITY_CATEGORY_TO_LORE: Record<"item" | "location" | "skill", LoreCategory> = {
  item: "items",
  location: "locations",
  skill: "skills",
};

const ENTITY_CATEGORY_TITLE: Record<"item" | "location" | "skill", string> = {
  item: "道具",
  location: "場景",
  skill: "技能",
};

/**
 * 把【現有文件全文】+【本回合相關敘事片段】丟給 LLM，要求輸出完整新版內容（不是 diff、不是片段）。
 * 失敗或輸出空白時回 null，呼叫端視為「這筆略過」。
 */
async function callLoreRewrite(
  client: LlmClient,
  settingText: string,
  excerpt: string,
  docTitle: string,
  existingContent: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是「無限恐怖」世界敘事引擎的知識庫維護者。任務：把【現有文件】依【本回合敘事片段】更新成一份完整、連貫的新版內容。",
        "鐵則：",
        "- 只輸出文件完整新版內容本身（純文字/Markdown），不要 JSON、不要前言、不要程式碼框。",
        "- 不可遺漏現有文件中仍然成立的事實；只在片段明確提供新資訊或訂正時才改動對應部分。",
        "- 不可發明片段未提及的事實。",
        "",
        "世界設定：",
        settingText.trim(),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `文件標題：${docTitle}`,
        "",
        existingContent.trim()
          ? `現有文件全文：\n${existingContent.trim()}`
          : "（目前沒有現有文件，這是全新建檔）",
        "",
        `本回合敘事片段：\n${excerpt.trim()}`,
      ].join("\n"),
    },
  ];
  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
  } catch {
    return null;
  }
  const content = raw.trim();
  return content.length > 0 ? content : null;
}

interface LoreRewriteResult {
  id: string;
  category: "npc" | "item" | "location" | "skill" | "dungeon";
  title: string;
  content: string;
}

/**
 * 對單一 touched entity：讀現有文件（NPC 角色檔 / 道具場景技能 wiki.md，缺檔視為全新建檔），
 * 若是道具/場景/技能且尚無 secrets 則先生成一次，再呼叫 callLoreRewrite 取得整檔新內容。
 * 單筆失敗（id 不合法 / LLM 呼叫失敗）回 null，不中斷其他筆。
 */
async function rewriteLoreEntity(
  deps: TurnDeps,
  settingText: string,
  entity: LoreEntityRef,
  log: Logger,
): Promise<LoreRewriteResult | null> {
  const rewriteClient = deps.loreClient ?? deps.controlClient ?? deps.client;

  if (entity.category === "npc") {
    if (!NPC_ID_RE.test(entity.id)) {
      log.warn({ entity }, "touched_entities 含不合法 NPC id，略過");
      return null;
    }
    const filePath = path.join(deps.worldDir, "characters", `${entity.id}.md`);
    const existing = await readBestEffort(filePath);
    const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, `NPC 角色檔案（${entity.name}）`, existing);
    if (!content) return null;
    // 角色檔重寫後的內容若以 `# 姓名` 開頭，以該標題為準（重寫可能訂正/確認姓名，
    // 例如全新角色從泛稱「陌生男子」具名化成「陳先生」）；否則退回 touched_entities 給的 name。
    const titleMatch = content.trim().match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1].trim() || entity.name;
    return { id: entity.id, category: "npc", title, content };
  }

  if (!ITEM_ID_RE.test(entity.id)) {
    log.warn({ entity }, "touched_entities 含不合法 id，略過");
    return null;
  }
  const category = ENTITY_CATEGORY_TO_LORE[entity.category];
  const existing = await loadLore(deps.worldDir, category, entity.id, log);
  if (!existing.secrets) {
    const secretsText = await generateItemSecrets(deps.client, settingText, entity.name);
    await ensureSecrets(deps.worldDir, category, entity.id, secretsText, `隱藏設定（${entity.name}）`, log);
  }
  const title = `${ENTITY_CATEGORY_TITLE[entity.category]}（${entity.id}）`;
  const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, title, existing.wiki);
  if (!content) return null;
  return { id: entity.id, category: entity.category, title, content };
}

// ---------- 回合核心 ----------

interface TurnPlan {
  /** 主腦（敘事）訊息 */
  messages: ChatMessage[];
  /** Layer 2（fast-control）訊息建構器：拿主腦完整敘事，回傳 fast-control 對話 */
  buildFastControl: (narrative: string) => ChatMessage[];
  /** Layer 3（reactive-lore-sync）訊息建構器：拿主腦完整敘事，回傳 lore-sync 對話 */
  buildLoreSync: (narrative: string) => ChatMessage[];
  /** raw 層落地：主空間→journal，副本→runs/<run>.md */
  appendRaw: (entry: { date: string; title: string; body: string }) => Promise<void>;
  /** raw 層檔案絕對路徑（journal.md 或 runs/<run>.md），供回合結束後重建語意索引用 */
  rawFilePath: string;
  /** 當前副本 id（僅副本回合有），供 Layer 3 落地 dungeon_wiki_excerpt 用 */
  dungeonId?: string;
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

/** 把本回合異動的檔案重新切塊嵌入進語意索引（derived cache，失敗只記警告，不影響回合落地） */
async function reindexTouchedFiles(
  recall: RecallIndex,
  worldDir: string,
  absPaths: string[],
  log: Logger,
): Promise<void> {
  for (const absPath of absPaths) {
    const relPath = path.relative(worldDir, absPath);
    try {
      const content = await readFile(absPath, "utf8");
      await recall.upsertFile(relPath, content);
    } catch (err) {
      log.warn({ err, relPath }, "recall 索引更新失敗，略過");
    }
  }
}

/**
 * Layer 2（fast-control）：done event 前必須就位的最小狀態（now/主角/骰值/轉場/建議動作）。
 * npc/item/location/skill/wiki 等可延後落地的欄位交給 runLoreSync（Layer 3），不在此處理。
 * 回傳本回合敘事全文，供呼叫端接著餵給 Layer 3。
 */
async function* runTurnCore(
  deps: TurnDeps,
  input: string,
  state: GameState,
  dicePool: number[],
  today: string,
  plan: TurnPlan,
  log: Logger,
): AsyncGenerator<TurnEvent, string> {
  log.debug({ dicePool }, "回合開始");

  // 1) 主腦：串流純敘事，delta 直接轉發（不再做 sentinel 切分）
  let narrative = "";
  for await (const delta of deps.client.streamChat(plan.messages)) {
    narrative += delta;
    yield { type: "delta", text: delta };
  }
  narrative = narrative.trim();

  // 2) Layer 2：讀完整敘事抽最小狀態子集；失敗則降級（敘事已落地、暫停等玩家）
  const controlClient = deps.controlClient ?? deps.client;
  let control: FastControl | null = null;
  let raw = "";
  try {
    for await (const delta of controlClient.streamChat(plan.buildFastControl(narrative))) {
      raw += delta;
    }
    control = parseFastControlOutput(raw);
  } catch (err) {
    log.error({ err, raw }, "Layer 2 fast-control 結構抽取失敗，本回合僅保留敘事並暫停");
    yield {
      type: "warning",
      message: `Layer 2 結構抽取失敗，本回合僅保留敘事並暫停：${(err as Error).message}`,
    };
  }

  if (control && control.rolls.length > 0) {
    log.debug({ rolls: control.rolls }, "本回合擲骰結果");
  }

  const summary = control?.commit_summary || deriveSummary(narrative);

  // 1. raw 層
  const rollsLine =
    control && control.rolls.length > 0
      ? `\n\n擲骰：${control.rolls.map((r) => `${r.desc}=${r.value}${r.success === undefined ? "" : r.success ? "(成功)" : "(失敗)"}`).join("、")}`
      : "";
  const suggestedActions = control?.suggested_actions ?? [];
  const suggestedLine = suggestedActions.length > 0 ? `\n\n建議動作：${suggestedActions.join("、")}` : "";
  await plan.appendRaw({
    date: today,
    title: summary,
    body: `玩家行動：${input}\n骰池：[${dicePool.join(", ")}]\n\n${narrative}${rollsLine}${suggestedLine}`,
  });

  // 2. 提煉頁 now.md
  const nowPath = path.join(deps.worldDir, "now.md");
  if (control) {
    // 進行中的副本欄由引擎依 mode_transition 管理（enterDungeon/setNowActiveDungeon），
    // 不接受 Layer 2 透過 now.activeDungeon 自行覆寫，避免繞過 run log/secrets 生成的正規流程。
    const { activeDungeon: _ignored, ...nowChanges } = control.state_changes.now ?? {};
    const newNow = applyNowChanges(state.now, nowChanges, { date: today, summary });
    await writeFile(nowPath, serializeNow(newNow), "utf8");
  } else {
    const nowMd = await readFile(nowPath, "utf8");
    await writeFile(nowPath, bumpNowUpdated(nowMd, { date: today, summary }), "utf8");
  }

  // 3. 主角狀態（積分 + 屬性/技能/物品/buff 新增項，否則主角的成長不會被記住）
  const delta = control?.state_changes.protagonist_points_delta ?? 0;
  const protagonistUpdates = control?.state_changes.protagonist_updates;
  if (delta || protagonistUpdates) {
    const pPath = path.join(deps.worldDir, "characters", "protagonist.md");
    let pMd = await readFile(pPath, "utf8");
    if (delta) pMd = applyPointsDelta(pMd, delta);
    if (protagonistUpdates) pMd = applyProtagonistUpdates(pMd, protagonistUpdates);
    await writeFile(pPath, pMd, "utf8");
  }

  // 4. 語意檢索索引：把本回合異動的檔案重新切塊嵌入（derived cache，與 git commit 內容無關）
  if (deps.recall) {
    const touched = [plan.rawFilePath];
    if (delta || protagonistUpdates) {
      touched.push(path.join(deps.worldDir, "characters", "protagonist.md"));
    }
    await reindexTouchedFiles(deps.recall, deps.worldDir, touched, log);
  }

  // 5. commit
  const committed = await deps.commit(summary);

  log.info(
    {
      committed,
      awaitingUserInput: control?.awaiting_user_input ?? true,
      modeTransition: control?.mode_transition ?? null,
    },
    "回合結束（Layer 2）",
  );

  yield {
    type: "done",
    narrative,
    committed,
    awaitingUserInput: control?.awaiting_user_input ?? true,
    suggestedActions,
    modeTransition: control?.mode_transition ?? null,
    transitionDungeonId: control?.transition_dungeon_id || undefined,
    transitionDungeonGoal: control?.transition_dungeon_goal || undefined,
  };

  return narrative;
}

/**
 * Layer 3（reactive-lore-sync）：讀主腦敘事，抽出 npc/item/location/skill/wiki 的延後落地欄位。
 * 不卡玩家可見的 done event；任何步驟失敗只 log.warn，永遠不拋錯（保證 pendingLoreSync.promise 不 reject）。
 * 本回合若沒有任何 lore 異動則不 commit，避免空 commit。
 */
async function runLoreSync(
  deps: TurnDeps,
  narrative: string,
  today: string,
  settingText: string,
  plan: TurnPlan,
  log: Logger,
): Promise<void> {
  try {
    const loreClient = deps.loreClient ?? deps.controlClient ?? deps.client;
    let raw = "";
    for await (const delta of loreClient.streamChat(plan.buildLoreSync(narrative))) {
      raw += delta;
    }
    const sync = parseLoreSyncOutput(raw);
    const changes = sync.state_changes;

    const entities = changes.touched_entities ?? [];
    const entityResults = await Promise.all(entities.map((e) => rewriteLoreEntity(deps, settingText, e, log)));

    let dungeonResult: LoreRewriteResult | null = null;
    if (changes.dungeon_wiki_excerpt && plan.dungeonId) {
      const rewriteClient = deps.loreClient ?? deps.controlClient ?? deps.client;
      const existing = await loadDungeonLore(deps.worldDir, plan.dungeonId, log);
      const title = `副本 ${plan.dungeonId} · 已揭露知識（Wiki）`;
      const content = await callLoreRewrite(rewriteClient, settingText, changes.dungeon_wiki_excerpt, title, existing.wiki);
      if (content) dungeonResult = { id: plan.dungeonId, category: "dungeon", title, content };
    }

    const results = [
      ...entityResults.filter((r): r is LoreRewriteResult => r !== null),
      ...(dungeonResult ? [dungeonResult] : []),
    ];

    const existingNpcIds: string[] = [];
    for (const r of results) {
      if (r.category === "npc") {
        const existed = Boolean(await readBestEffort(path.join(deps.worldDir, "characters", `${r.id}.md`)));
        await rewriteNpcFile(deps.worldDir, r.id, r.content, log);
        if (existed) {
          existingNpcIds.push(r.id);
        } else {
          const indexPath = path.join(deps.worldDir, "characters", "index.md");
          const indexMd = await readBestEffort(indexPath);
          if (indexMd) await writeFile(indexPath, addCharacterIndexRow(indexMd, r.id, r.title), "utf8");
        }
      } else {
        const category = r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category];
        await rewriteLoreWiki(deps.worldDir, category, r.id, r.content, r.title, log);
      }
    }

    // 全新建檔的 NPC 維持 addCharacterIndexRow 的預設「初次登場」，不額外摘要近況
    // （本回合剛建檔，立刻再摘要一次沒有額外價值，也避免多耗一次小模型呼叫）。
    const npcIds = results.filter((r) => r.category === "npc").map((r) => r.id);
    if (existingNpcIds.length > 0) await syncCharacterIndexStatus(deps, existingNpcIds, log);

    if (deps.recall) {
      const touched: string[] = results.map((r) =>
        r.category === "npc"
          ? path.join(deps.worldDir, "characters", `${r.id}.md`)
          : path.join(loreDir(deps.worldDir, r.category === "dungeon" ? "dungeons" : ENTITY_CATEGORY_TO_LORE[r.category], r.id), "wiki.md"),
      );
      if (npcIds.length > 0) touched.push(path.join(deps.worldDir, "characters", "index.md"));
      if (touched.length > 0) await reindexTouchedFiles(deps.recall, deps.worldDir, touched, log);
    }

    if (results.length > 0) {
      const committed = await deps.commit("補完關聯文件（NPC/道具/場景/技能）");
      log.info({ committed }, "回合結束（Layer 3 reactive-lore-sync）");
    } else {
      log.debug("Layer 3 reactive-lore-sync 本回合無 lore 異動，跳過 commit");
    }
  } catch (err) {
    log.warn({ err }, "Layer 3 reactive-lore-sync 失敗，本回合 lore 文件可能未完整補上");
  }
}

/**
 * 對在場 NPC 跑角色意圖 pre-pass，回傳 warning events 與格式化後的 intentsBlock。
 * 失敗靜默降級——不 block 回合，但 yield warning 讓前端可觀察。
 */
async function* runPrePassBlock(
  deps: TurnDeps,
  state: GameState,
  input: string,
): AsyncGenerator<TurnEvent, string> {
  const charClient = deps.characterClient ?? deps.client;
  const npcIds = parseCompanionIds(state.now.companions, state.npcs);
  const npcNames = Object.fromEntries(state.npcs.map((n) => [n.id, n.name]));
  if (npcIds.length === 0) return "";

  let intents: import("./character-pre-pass.js").CharacterIntent[];
  try {
    intents = await runCharacterPrePass({
      npcIds,
      scene: state.now.scene,
      playerInput: input,
      worldDir: deps.worldDir,
      client: charClient,
    });
  } catch (err) {
    yield {
      type: "warning" as const,
      message: `character pre-pass 全部失敗：${(err as Error).message}`,
    };
    return "";
  }

  if (intents.length < npcIds.length) {
    const returnedIds = new Set(intents.map((i) => i.id));
    const missing = npcIds.filter((id) => !returnedIds.has(id));
    yield {
      type: "warning" as const,
      message: `character pre-pass 部分失敗，略過：${missing.join(", ")}`,
    };
  }

  return formatIntentsBlock(intents, npcNames);
}

const DEFAULT_RECALL_TOP_K = 5;

/**
 * 對 deps.recall（若有）以玩家輸入做語意檢索，格式化成 recallBlock。
 * 失敗靜默降級——不 block 回合，但 yield warning 讓前端可觀察。
 */
async function* runRecallBlock(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent, string> {
  if (!deps.recall) return "";
  try {
    const hits = await deps.recall.query(input, deps.recallTopK ?? DEFAULT_RECALL_TOP_K);
    return formatRecallBlock(hits);
  } catch (err) {
    yield { type: "warning" as const, message: `recall 檢索失敗，略過：${(err as Error).message}` };
    return "";
  }
}

/**
 * 回合結束後啟動 Layer 3（不 await，讓回合本身立即結束）；有 pendingLoreSync handle 時
 * 接力寫回 handle，下一回合開始前會等它；沒有 handle（如未接線的舊呼叫端）則同步 await，
 * 維持「回合即時落地」的舊保證。
 */
function scheduleLoreSync(
  deps: TurnDeps,
  narrative: string,
  today: string,
  settingText: string,
  plan: TurnPlan,
  log: Logger,
): Promise<void> {
  const task = runLoreSync(deps, narrative, today, settingText, plan, log);
  if (deps.pendingLoreSync) {
    trackLoreSync(deps.pendingLoreSync, task, log);
    return Promise.resolve();
  }
  return task;
}

/** 主空間敘事回合 */
export async function* runMainSpaceTurn(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent> {
  const log = (deps.logger ?? defaultLogger).child({ mode: "main-space" });
  await deps.pendingLoreSync?.promise;

  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir, log);
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));

  const intentsBlock = yield* runPrePassBlock(deps, state, input);
  const recallBlock = yield* runRecallBlock(deps, input);

  const existingDungeonIds = await listDungeonIds(deps.worldDir, log);

  const plan: TurnPlan = {
    messages: buildMainSpaceMessages({ settingText, state, input, dicePool, intentsBlock, recallBlock }),
    buildFastControl: (narrative) =>
      buildFastControlMessages({ settingText, state, input, narrative, dicePool, existingDungeonIds }),
    buildLoreSync: (narrative) =>
      buildLoreSyncMessages({ settingText, state, input, narrative, dicePool, existingDungeonIds }),
    appendRaw: (entry) => appendJournal(deps.worldDir, entry),
    rawFilePath: path.join(deps.worldDir, "journal.md"),
  };

  const narrative = yield* runTurnCore(deps, input, state, dicePool, today, plan, log);
  await scheduleLoreSync(deps, narrative, today, settingText, plan, log);
}

/** 副本敘事回合（讀當前 now.md 的進行中副本，落地到 runs/*.md、提煉 wiki） */
export async function* runDungeonTurn(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent> {
  const baseLog = deps.logger ?? defaultLogger;
  await deps.pendingLoreSync?.promise;

  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir, baseLog);
  const active = parseActiveDungeon(state.now.activeDungeon);
  if (!active) {
    // 不在副本中卻被呼叫 → 退回主空間回合
    yield* runMainSpaceTurn(deps, input);
    return;
  }
  const log = baseLog.child({ mode: "dungeon", dungeonId: active.dungeonId, runId: active.runId });
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));
  const lore = await loadDungeonLore(deps.worldDir, active.dungeonId, log);

  const intentsBlock = yield* runPrePassBlock(deps, state, input);
  const recallBlock = yield* runRecallBlock(deps, input);

  const plan: TurnPlan = {
    messages: buildDungeonMessages({
      settingText, state, input, dicePool,
      dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      intentsBlock, recallBlock,
    }),
    buildFastControl: (narrative) =>
      buildFastControlMessages({
        settingText, state, input, narrative, dicePool,
        dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      }),
    buildLoreSync: (narrative) =>
      buildLoreSyncMessages({
        settingText, state, input, narrative, dicePool,
        dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
      }),
    appendRaw: (entry) => appendRun(deps.worldDir, active.dungeonId, active.runId, entry),
    rawFilePath: path.join(deps.worldDir, "dungeons", active.dungeonId, "runs", `${active.runId}.md`),
    dungeonId: active.dungeonId,
  };

  const narrative = yield* runTurnCore(deps, input, state, dicePool, today, plan, log);
  await scheduleLoreSync(deps, narrative, today, settingText, plan, log);
}

const AUTO_CONTINUE_INPUT = "（系統自動推進：延續上一刻，繼續敘事，玩家未介入）";

async function generateSecrets(client: LlmClient, settingText: string, dungeonId: string): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的副本設計者。為指定副本生成隱藏真相（機關原理、暗藏轉折、NPC 真實動機、主線/隱藏目標）。" +
        "這是劇透文件，玩家永遠不會直接看到，只供敘事暗線一致。只輸出真相內容本身，繁體中文，不要前言或客套。\n\n" +
        "世界設定：\n" + settingText.trim(),
    },
    { role: "user", content: `副本 id：${dungeonId}。請生成其隱藏真相。` },
  ];
  let full = "";
  for await (const d of client.streamChat(messages)) full += d;
  return full.trim() || "（生成失敗，待補）";
}

/** 覆寫 now.md 的進行中副本欄並更新時間戳 */
async function setNowActiveDungeon(
  worldDir: string,
  value: string,
  update: { date: string; summary: string },
): Promise<void> {
  const nowPath = path.join(worldDir, "now.md");
  const now = parseNow(await readFile(nowPath, "utf8"));
  now.activeDungeon = value;
  now.lastUpdated = `[${update.date}] ${update.summary}`;
  await writeFile(nowPath, serializeNow(now), "utf8");
}

/**
 * Mode-aware 自動推進迴圈：依 now.md 模式 dispatch 主空間/副本回合；
 * awaiting_user_input=false 時自動接續；mode_transition 觸發進/結算副本（不切 branch）。
 */
export async function* runTurnLoop(
  deps: TurnDeps,
  input: string,
  maxAuto: number,
): AsyncGenerator<TurnEvent> {
  const log = deps.logger ?? defaultLogger;
  const today = (deps.today ?? todayISO)();
  let currentInput = input;

  for (let i = 0; i <= maxAuto; i++) {
    const state = await loadState(deps.worldDir, log);
    const gen = state.mode === "dungeon" ? runDungeonTurn(deps, currentInput) : runMainSpaceTurn(deps, currentInput);

    let done: Extract<TurnEvent, { type: "done" }> | null = null;
    for await (const ev of gen) {
      yield ev;
      if (ev.type === "done") done = ev;
    }
    currentInput = AUTO_CONTINUE_INPUT;
    if (!done) break;

    // enter_dungeon 但副大腦沒給 transition_dungeon_id：無法建副本，不可靜默吞掉
    if (done.modeTransition === "enter_dungeon" && !done.transitionDungeonId) {
      log.warn("mode_transition=enter_dungeon 但缺 transition_dungeon_id，無法進入副本，停在主空間等玩家");
      yield {
        type: "warning",
        message: "系統判定要進入副本，但未能確定副本 id，暫停等玩家確認。",
      };
      break;
    }

    // 進入副本：生成 secrets、建 run、設 now，再自動接續第一個副本回合
    if (done.modeTransition === "enter_dungeon" && done.transitionDungeonId) {
      log.info({ dungeonId: done.transitionDungeonId }, "觸發 mode_transition：enter_dungeon");
      // 即將自行 commit；先等本回合的 Layer 3 落地完，避免兩個 git commit 並發搶鎖
      await deps.pendingLoreSync?.promise;
      const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));
      const secretsText = await generateSecrets(deps.client, settingText, done.transitionDungeonId);
      const active = await enterDungeon(
        deps.worldDir,
        {
          dungeonId: done.transitionDungeonId,
          today,
          protagonistSummary: `${state.protagonist.name}（積分 ${state.protagonist.points}）`,
          goal: done.transitionDungeonGoal?.trim() || "（待劇情揭露）",
          secretsText,
        },
        log,
      );
      await setNowActiveDungeon(deps.worldDir, formatActiveDungeon(active), {
        date: today,
        summary: `進入副本 ${active.dungeonId}`,
      });
      await deps.commit(`進入副本 ${active.dungeonId} ${active.runId}`);
      yield { type: "transition", to: "dungeon", dungeonId: active.dungeonId };
      if (i === maxAuto) break;
      yield { type: "auto-advance", index: i + 1 };
      continue;
    }

    // 結算副本：清空進行中副本欄，回主空間，交還玩家
    if (done.modeTransition === "settle_dungeon") {
      log.info({ dungeonId: state.now.activeDungeon }, "觸發 mode_transition：settle_dungeon");
      // 即將自行 commit；先等本回合的 Layer 3 落地完，避免兩個 git commit 並發搶鎖
      await deps.pendingLoreSync?.promise;
      await setNowActiveDungeon(deps.worldDir, "無", { date: today, summary: "副本結算，返回安全區" });
      await deps.commit("副本結算，返回安全區");
      yield { type: "transition", to: "main-space" };
      break;
    }

    if (done.awaitingUserInput) break;
    if (i === maxAuto) break;
    log.debug({ index: i + 1 }, "自動推進到下一回合");
    yield { type: "auto-advance", index: i + 1 };
  }
}
