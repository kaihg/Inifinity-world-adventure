import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import type { Logger } from "../logger.js";
import { TRADITIONAL_CHINESE_RULE } from "./turn/prompts.js";

const ExtractedEntitySchema = z.object({
  id: z.string(),
  category: z.enum(["skill", "item", "scene", "dungeon", "character"]),
  name: z.string(),
});

const ExtractionResultSchema = z.object({
  protagonist_changed: z.boolean().default(false),
  entities: z.array(ExtractedEntitySchema).default([]),
});

export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export async function extractEntities(
  client: LlmClient,
  narrative: string,
  assetBible: string,
  existingIds: Record<string, string[]>,
  log: Logger,
): Promise<ExtractionResult> {
  const existingList = Object.entries(existingIds)
    .map(([cat, ids]) => `${cat}: ${ids.join(", ") || "（無）"}`)
    .join("\n");

  const messages = [
    {
      role: "system" as const,
      content: [
        "你是「無限恐怖」世界敘事引擎的知識庫索引器。從敘事片段中識別「有狀態變化的實體」。",
        "只輸出 JSON，格式如下：",
        '{"protagonist_changed": bool, "entities": [{"id": string, "category": "skill"|"item"|"scene"|"dungeon"|"character", "name": string}]}',
        "",
        "規則：",
        "- protagonist_changed：主角有屬性/技能/物品/積分/buff 變化時為 true",
        "- entities：本回合有資訊更新的 NPC、道具、場景、技能、副本",
        "- id 優先使用已存在的 id（見下方清單），沒有匹配才用顯示名稱當 id",
        "- 主角本身不列入 entities（用 protagonist_changed 表示）",
        "- 主空間的日常對話、無變化的背景描述不要列入",
        `${TRADITIONAL_CHINESE_RULE}`,
        "",
        "已存在的實體 id：",
        existingList || "（無）",
        assetBible ? `\n資產約束（asset-bible）：\n${assetBible}` : "",
      ].join("\n"),
    },
    { role: "user" as const, content: `敘事片段：\n${narrative}` },
  ];

  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no JSON found");
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return ExtractionResultSchema.parse(parsed);
  } catch (err) {
    log.warn({ err }, "entity extraction 失敗，略過本次 ingest");
    return { protagonist_changed: false, entities: [] };
  }
}
