import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { Logger } from "../../logger.js";
import { NPC_ID_RE } from "../context.js";
import { ensureSecrets, loadLore, type LoreCategory } from "../lore.js";
import type { LoreEntityRef } from "../schema.js";
import { readBestEffort } from "./shared.js";
import type { TurnDeps } from "./types.js";

/** 防止路徑穿越：道具/場景/技能/副本 id 只允許英數字、連字號、底線、點（不含路徑分隔符） */
export const ITEM_ID_RE = /^[\w.-]+$/;

/** 隱藏設定生成者，依分類套用對應的世界觀角色稱呼（道具/場景/技能設計者措辭不同） */
export const ENTITY_SECRETS_DESIGNER_ROLE: Record<"item" | "location" | "skill", string> = {
  item: "道具設計者",
  location: "場景設計者",
  skill: "技能設計者",
};

/** 為指定實體生成隱藏設定（劇透文件，僅供暗線一致，不可外洩）；依分類套用正確的角色稱呼與名詞，風格與 callLoreRewrite 對齊 */
export async function generateEntitySecrets(
  client: LlmClient,
  settingText: string,
  entityName: string,
  category: "item" | "location" | "skill",
  log: Logger,
): Promise<string> {
  const noun = ENTITY_CATEGORY_TITLE[category];
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `你是「無限恐怖」世界的${ENTITY_SECRETS_DESIGNER_ROLE[category]}。為指定${noun}生成隱藏設定（真實來歷、隱藏效果、與主線的關聯）。` +
        "這是劇透文件，玩家永遠不會直接看到，只供敘事暗線一致。只輸出設定內容本身，使用繁體中文書寫；避免使用中國大陸簡體中文慣用詞彙（例如「質量」→「品質」、「視頻」→「影片」、「軟件」→「軟體」、「信息」→「資訊」、「打印」→「列印」等），用詞符合台灣繁體中文書寫習慣。不要前言或客套。\n\n" +
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
  return full.trim() || "（生成失敗，待補）";
}

export const ENTITY_CATEGORY_TO_LORE: Record<"item" | "location" | "skill", LoreCategory> = {
  item: "items",
  location: "locations",
  skill: "skills",
};

export const ENTITY_CATEGORY_TITLE: Record<"item" | "location" | "skill", string> = {
  item: "道具",
  location: "場景",
  skill: "技能",
};

export type LoreRewriteCategory = "npc" | "item" | "location" | "skill" | "dungeon";

/** 各分類 wiki 常見可寫面向，純引導模型涵蓋玩家會想知道的基本說明，不是強制欄位 */
export const LORE_REWRITE_CATEGORY_OUTLINE: Record<LoreRewriteCategory, string> = {
  npc: "- 基本資訊（外觀/身份/性格）\n- 與主角的關係\n- 已知情報（自述/可驗證情報）\n- 備註/未解疑點",
  item:
    "- 外觀與基本辨識\n- 已知效果/用途（玩家視角已知的）\n- 取得或使用方式/限制\n- 目前已知的來歷或關聯人物事件（僅寫敘事中已揭露的部分）",
  location: "- 地理/環境描述\n- 已知規則或機關（已揭露部分）\n- 已知危險與資源\n- 出沒生物或 NPC",
  skill: "- 效果說明\n- 施展條件/限制\n- 已知代價或副作用\n- 取得方式",
  dungeon: "- 已揭露地圖/環境\n- 已知規則或機關\n- 已知危險與資源\n- 相關人物事件",
};

/**
 * 把【現有文件全文】+【本回合相關敘事片段】丟給 LLM，要求輸出完整新版內容（不是 diff、不是片段）。
 * 失敗或輸出空白時回 null，呼叫端視為「這筆略過」。
 */
export async function callLoreRewrite(
  client: LlmClient,
  settingText: string,
  excerpt: string,
  docTitle: string,
  existingContent: string,
  category: LoreRewriteCategory,
  log: Logger,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是「無限恐怖」世界敘事引擎的知識庫維護者。任務：把【現有文件】依【本回合敘事片段】更新成一份完整、連貫的新版內容。",
        "",
        "語言與用詞：",
        "- 一律使用繁體中文書寫；避免使用中國大陸簡體中文慣用詞彙（例如「質量」→「品質」、「視頻」→「影片」、「軟件」→「軟體」、「信息」→「資訊」、「打印」→「列印」等），用詞符合台灣繁體中文書寫習慣。",
        "",
        "這份文件常見的可寫面向（不是每筆都要填滿；本回合片段沒提到、也沒有合理依據可擴寫的面向不要硬湊）：",
        LORE_REWRITE_CATEGORY_OUTLINE[category],
        "",
        "鐵則：",
        "- 只輸出文件完整新版內容本身（純文字/Markdown），不要 JSON、不要前言、不要程式碼框。",
        "- 若【現有文件全文】非空（更新既有文件）：不可遺漏現有文件中仍然成立的事實；只在片段明確提供新資訊或訂正時才改動對應部分；不可發明片段未提及的事實。",
        "- 若目前沒有現有文件（全新建檔）：可以在風格/氛圍類細節上做簡單合理的擴寫（例如視覺風格、材質、光線、氣味、外觀質感），讓內容有畫面感、之後好沿用；但不可發明會影響劇情走向的具體事實（真正用途、特殊機關、隱藏效果、與主線人物事件的關聯）——這些留給之後敘事片段揭露，或由暗線文件承接。本次擴寫過的風格細節，之後更新文件時要視為既定事實，不可無故更動。",
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
  } catch (err) {
    log.warn({ err }, "Layer 3 整檔重寫 LLM 呼叫失敗，略過該筆");
    return null;
  }
  const content = raw.trim();
  return content.length > 0 ? content : null;
}

export interface LoreRewriteResult {
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
export async function rewriteLoreEntity(
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
    const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, `NPC 角色檔案（${entity.name}）`, existing, "npc", log);
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
    const secretsText = await generateEntitySecrets(deps.client, settingText, entity.name, entity.category, log);
    await ensureSecrets(deps.worldDir, category, entity.id, secretsText, `隱藏設定（${entity.name}）`, log);
  }
  const title = `${ENTITY_CATEGORY_TITLE[entity.category]}（${entity.name}）`;
  const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, title, existing.wiki, entity.category, log);
  if (!content) return null;
  return { id: entity.id, category: entity.category, title, content };
}
