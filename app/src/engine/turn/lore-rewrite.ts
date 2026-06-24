import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { Logger } from "../../logger.js";
import { NPC_ID_RE } from "../context.js";
import { ensureSecrets, loadLore, type LoreCategory } from "../lore.js";
import type { LoreEntityRef } from "../schema.js";
import { TRADITIONAL_CHINESE_RULE } from "./prompts.js";
import { readBestEffort } from "./shared.js";
import { toTraditional } from "../text/traditionalize.js";
import type { TurnDeps } from "./types.js";

/** 防止路徑穿越：道具/場景/技能/副本 id 只允許英數字、連字號、底線、點（不含路徑分隔符） */
export const ITEM_ID_RE = /^[\w.-]+$/;

/** 隱藏設定生成者，依分類套用對應的世界觀角色稱呼（道具/場景/技能設計者措辭不同） */
export const ENTITY_SECRETS_DESIGNER_ROLE: Record<"item" | "scene" | "skill", string> = {
  item: "道具設計者",
  scene: "場景設計者",
  skill: "技能設計者",
};

/** 為指定實體生成隱藏設定（劇透文件，僅供暗線一致，不可外洩）；依分類套用正確的角色稱呼與名詞，風格與 callLoreRewrite 對齊 */
export async function generateEntitySecrets(
  client: LlmClient,
  settingText: string,
  entityName: string,
  category: "item" | "scene" | "skill",
  log: Logger,
): Promise<string> {
  const noun = ENTITY_CATEGORY_TITLE[category];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `你是「無限恐怖」世界的${ENTITY_SECRETS_DESIGNER_ROLE[category]}。為指定${noun}生成隱藏設定（真實來歷、隱藏效果、與主線的關聯）。` +
        `這是劇透文件，玩家永遠不會直接看到，只供敘事暗線一致。只輸出設定內容本身。${TRADITIONAL_CHINESE_RULE}不要前言或客套。\n\n` +
        "世界設定：\n" + settingText.trim(),
    },
    { role: "user", content: `${noun}名稱：${entityName}。請生成其隱藏設定。` },
  ];
  let full = "";
  try {
    for await (const d of client.streamChat(messages)) full += d;
  } catch (err) {
    log.warn({ err }, "隱藏設定生成 LLM 呼叫失敗，回退預設文字");
    return "（生成失敗，待補）";
  }
  // 落地進 secrets.md 前繁體化（小模型較易吐簡體，決定論兜底）
  return toTraditional(full.trim()) || "（生成失敗，待補）";
}

export const ENTITY_CATEGORY_TO_LORE: Record<"item" | "scene" | "skill", LoreCategory> = {
  item: "items",
  scene: "scenes",
  skill: "skills",
};

export const ENTITY_CATEGORY_TITLE: Record<"item" | "scene" | "skill", string> = {
  item: "道具",
  scene: "場景",
  skill: "技能",
};

export type LoreRewriteCategory = "npc" | "item" | "scene" | "skill" | "dungeon";

/** 各分類 wiki 常見可寫面向，純引導模型涵蓋玩家會想知道的基本說明，不是強制欄位 */
export const LORE_REWRITE_CATEGORY_OUTLINE: Record<LoreRewriteCategory, string> = {
  npc: "- 基本資訊（外觀/身份/性格）\n- 與主角的關係\n- 已知情報（自述/可驗證情報）\n- 備註/未解疑點",
  item:
    "- 外觀與基本辨識\n- 已知效果/用途（玩家視角已知的）\n- 取得或使用方式/限制\n- 目前已知的來歷或關聯人物事件（僅寫敘事中已揭露的部分）",
  scene: "- 地理/環境描述\n- 已知規則或機關（已揭露部分）\n- 已知危險與資源\n- 出沒生物或 NPC",
  skill: "- 效果說明\n- 施展條件/限制\n- 已知代價或副作用\n- 取得方式",
  dungeon: "- 已揭露地圖/環境\n- 已知規則或機關\n- 已知危險與資源\n- 相關人物事件",
};

/**
 * 把【現有文件全文】+【本回合相關敘事片段】丟給 LLM，要求輸出完整新版內容（不是 diff、不是片段）。
 * 失敗或輸出空白時回 null，呼叫端視為「這筆略過」。
 */
/** 本回合情境：讓知識庫維護者判斷場景歸屬，避免把安全區事件誤寫成副本內（反之亦然） */
export interface LoreRewriteContext {
  inDungeon: boolean;
  dungeonId?: string;
}

function formatContextLine(ctx: LoreRewriteContext): string {
  const where = ctx.inDungeon
    ? `在副本「${ctx.dungeonId ?? "進行中副本"}」內`
    : "在主神空間安全區（非副本）";
  return `本回合情境：主角目前${where}。只據此判斷場景歸屬，不要把安全區事件誤寫成副本內，反之亦然。`;
}

export async function callLoreRewrite(
  client: LlmClient,
  settingText: string,
  excerpt: string,
  docTitle: string,
  existingContent: string,
  category: LoreRewriteCategory,
  log: Logger,
  context?: LoreRewriteContext,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是「無限恐怖」世界敘事引擎的知識庫維護者。任務：把【現有文件】依【本回合敘事片段】更新成一份完整、連貫的新版內容。",
        "",
        "語言與用詞：",
        `- ${TRADITIONAL_CHINESE_RULE}`,
        "",
        "這份文件常見的可寫面向（不是每筆都要填滿；本回合片段沒提到、也沒有合理依據可擴寫的面向不要硬湊）：",
        LORE_REWRITE_CATEGORY_OUTLINE[category],
        "",
        "鐵則：",
        "- 只輸出文件完整新版內容本身（純文字/Markdown），不要 JSON、不要前言、不要程式碼框。",
        "- 若【現有文件全文】非空（更新既有文件）：不可遺漏現有文件中仍然成立的事實；只在片段明確提供新資訊或訂正時才改動對應部分；不可發明片段未提及的事實。",
        "- 若目前沒有現有文件（全新建檔）：只依本回合敘事片段已明確描述的內容整理成檔；**不可發明、不可擴寫敘事未提供的任何細節**（含視覺風格、材質、光線、氣味、用途、效果、機關、來歷、與人物事件的關聯）。片段沒提到的面向就留白，不要硬填、不要為了畫面感而想像。後續敘事揭露更多時再補。",
        "- 輸出是**整理過的知識條目**，不是敘事轉貼。禁止把本回合敘事片段的散文、對白、系統提示（如【系統公告】【副本載入完畢】【系統提示】）原文照搬進文件；只能把片段中的事實**提煉**成條列式設定描述。文件中不應出現「本回合」「沈奕這時」這類敘事時序語句。",
        "",
        "世界設定：",
        settingText.trim(),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `文件標題：${docTitle}`,
        ...(context ? ["", formatContextLine(context)] : []),
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
  } catch (err) {
    log.warn({ err }, "Layer 3 整檔重寫 LLM 呼叫失敗，略過該筆");
    return null;
  }
  // 落地進 wiki.md / 角色檔前繁體化（決定論兜底，斷雪球）
  const content = toTraditional(raw.trim());
  return content.length > 0 ? content : null;
}

/**
 * 主角檔案（protagonist.md）整檔重寫：把【現有全文（積分已由引擎決定論落地）】+【本回合敘事片段】
 * 丟給 LLM，要求輸出完整新版內容。對標 callLoreRewrite，但積分區塊必須照抄不可改動
 * （引擎已算好寫進現有全文），模型只負責整合屬性/技能/物品/buff 的成長，天然去重。
 * 失敗或空白回 null（呼叫端保留現有全文不覆寫）。
 */
export async function callProtagonistRewrite(
  client: LlmClient,
  settingText: string,
  excerpt: string,
  existingContent: string,
  log: Logger,
  context?: LoreRewriteContext,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是「無限恐怖」世界敘事引擎的主角檔案維護者。任務：把【現有主角檔案全文】依【本回合敘事片段】更新成一份完整、連貫的新版內容。",
        "",
        "語言與用詞：",
        `- ${TRADITIONAL_CHINESE_RULE}`,
        "",
        "鐵則：",
        "- 只輸出主角檔案完整新版內容本身（純文字/Markdown），不要 JSON、不要前言、不要程式碼框。",
        "- **「當前積分」數值與其所在區塊一律照抄現有全文，絕不可改動**（積分由引擎另行計算，你動了就是錯）。",
        "- 不可遺漏現有全文中仍然成立的事實；只在敘事片段明確提供新的屬性/技能/物品/buff 變化時，才把該變化整合進對應區塊。",
        "- 整合時若某項已存在（即使措辭不同），更新該項而非新增重複條目；不可發明敘事未提及的成長。",
        "- 輸出是整理過的角色檔案，不是敘事轉貼。禁止把敘事片段的散文、對白、系統提示原文照抄進檔；文件中不應出現「本回合」這類敘事時序語句。",
        "",
        "世界設定：",
        settingText.trim(),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        ...(context ? [formatContextLine(context), ""] : []),
        `現有主角檔案全文：\n${existingContent.trim()}`,
        "",
        `本回合敘事片段：\n${excerpt.trim()}`,
      ].join("\n"),
    },
  ];
  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
  } catch (err) {
    log.warn({ err }, "主角檔案整檔重寫 LLM 呼叫失敗，保留現有檔案");
    return null;
  }
  const content = toTraditional(raw.trim());
  return content.length > 0 ? content : null;
}

export interface LoreRewriteResult {
  id: string;
  category: "npc" | "item" | "scene" | "skill" | "dungeon";
  title: string;
  content: string;
}

/**
 * 對單一 touched entity：讀現有文件（NPC 角色檔 / 道具場景技能 wiki.md，缺檔視為全新建檔），
 * 若是道具/場景/技能且尚無 secrets 則先生成一次，再呼叫 callLoreRewrite 取得整檔新內容。
 * 單筆失敗（id 不合法 / LLM 呼叫失敗）回 null，不中斷其他筆。
 */
export async function rewriteLoreEntity(
  deps: TurnDeps,
  settingText: string,
  entity: LoreEntityRef,
  log: Logger,
  context?: LoreRewriteContext,
): Promise<LoreRewriteResult | null> {
  const rewriteClient = deps.loreClient ?? deps.controlClient ?? deps.client;

  if (entity.category === "npc") {
    if (!NPC_ID_RE.test(entity.id)) {
      log.warn({ entity }, "touched_entities 含不合法 NPC id，略過");
      return null;
    }
    const filePath = path.join(deps.worldDir, "characters", `${entity.id}.md`);
    const existing = await readBestEffort(filePath);
    const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, `NPC 角色檔案（${entity.name}）`, existing, "npc", log, context);
    if (!content) return null;
    // 只認「開頭第一行」的 H1（`# 姓名`）為已自帶標題，以該標題為準（重寫可能訂正/確認姓名，
    // 例如全新角色從泛稱「陌生男子」具名化成「陳先生」），內容原樣保留。
    // 否則退回 touched_entities 的 name，並補上正確 H1
    //（根因 I：模型常用 `###` 起頭，不補會讓角色檔從 `###` 開始、層級錯亂；
    //  C3：錨點限定第一行——與 rewriteLoreWiki 的 /^#\s/ 一致——避免被內文任意行的 `# x` 騙過）。
    const trimmed = content.trim();
    const h1Match = trimmed.match(/^#\s+(.+)(?:\n|$)/);
    const title = h1Match?.[1].trim() || entity.name;
    const normalized = h1Match ? trimmed : `# ${title}\n\n${trimmed}`;
    return { id: entity.id, category: "npc", title, content: normalized };
  }

  if (!ITEM_ID_RE.test(entity.id)) {
    log.warn({ entity }, "touched_entities 含不合法 id，略過");
    return null;
  }
  const category = ENTITY_CATEGORY_TO_LORE[entity.category];
  const existing = await loadLore(deps.worldDir, category, entity.id, log);
  if (!existing.secrets) {
    // secrets 是玩家永不見、只生成一次的暗線文件，用小模型（loreClient→controlClient→client）即可，
    // 不必占用主敘事大模型；A 校驗 gate 修好後此處呼叫量本就大降。
    const secretsClient = deps.loreClient ?? deps.controlClient ?? deps.client;
    const secretsText = await generateEntitySecrets(secretsClient, settingText, entity.name, entity.category, log);
    await ensureSecrets(deps.worldDir, category, entity.id, secretsText, `隱藏設定（${entity.name}）`, log);
  }
  const title = `${ENTITY_CATEGORY_TITLE[entity.category]}（${entity.name}）`;
  const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, title, existing.wiki, entity.category, log, context);
  if (!content) return null;
  return { id: entity.id, category: entity.category, title, content };
}
