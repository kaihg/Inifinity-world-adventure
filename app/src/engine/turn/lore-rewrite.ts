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

/** 為指定道具生成隱藏設定（劇透文件，僅供暗線一致，不可外洩）；風格與 generateSecrets 對齊 */
export async function generateItemSecrets(client: LlmClient, settingText: string, itemName: string): Promise<string> {
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
  log: Logger,
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
    const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, `NPC 角色檔案（${entity.name}）`, existing, log);
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
  const content = await callLoreRewrite(rewriteClient, settingText, entity.excerpt, title, existing.wiki, log);
  if (!content) return null;
  return { id: entity.id, category: entity.category, title, content };
}
