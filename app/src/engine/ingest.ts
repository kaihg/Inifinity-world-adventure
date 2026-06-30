import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmClient } from "../llm/client.js";
import type { Logger } from "../logger.js";
import { loadLoreFile, loreFilePath, rewriteLoreFile, listLoreIds, sanitizeLoreId, type LoreCategory } from "./lore.js";
import {
  callLoreRewrite,
  callProtagonistRewrite,
  ENTITY_CATEGORY_TITLE,
  type LoreRewriteCategory,
} from "./turn/lore-rewrite.js";
import { getTemplate } from "./template-loader.js";
import { toTraditional } from "./text/traditionalize.js";
import { TRADITIONAL_CHINESE_RULE } from "./turn/prompts.js";
import { reindexTouchedFiles } from "./turn/shared.js";
import type { TurnDeps } from "./turn/types.js";

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

/** ExtractedEntity.category → LoreCategory（"character" 不在此 map，會被略過） */
const CATEGORY_TO_LORE: Record<string, LoreCategory> = {
  skill: "skills",
  item: "items",
  scene: "scenes",
  dungeon: "dungeons",
};

/** ExtractedEntity.category → 文件標題前綴 */
const CATEGORY_TITLE: Record<string, string> = {
  ...(ENTITY_CATEGORY_TITLE as Record<string, string>),
  dungeon: "副本",
};

/** 各分類 wiki 索引格式提示 */
const WIKI_FORMAT_HINT: Record<LoreCategory, string> = {
  skills: "分「主動技能」「被動技能」兩大段，各技能一行 `- [[id]]：一句中性描述`（不寫持有者或取得狀態）",
  items: "分「消耗品」「持久道具」兩大段，各道具一行 `- [[id]]：品質等級、一句中性描述`",
  scenes: "分「主空間場景」「副本場景（副本名）」兩大段，各場景一行 `- [[id]]：環境基調`",
  dungeons: "各副本一行 `- [[id]]：難度基調、狀態（進行中/已結算）`",
};

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
        "- 所有 entity id 直接使用中文正式名稱，不做英文翻譯或 snake_case 轉換（例如「主神空間」而非 main_space）",
        "- scene 的 id 使用場所的中文正式名稱；同一物理地點只能有一個 scene entity，禁止為同一場所的不同面向建立多個 id",
        "- dungeon 的 id 使用副本的中文正式名稱（例如「生化危機：浣熊市」）",
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

/**
 * 完整三步 ingest 管線：
 * Step 1 – 從 narrative 抽實體（extractEntities）
 * Step 2 – 平行 rewrite 每個 entity 的 .md 檔
 * Step 3 – 對有更新的每個分類 rewrite wiki.md
 * 有任何更新時自動 commit world/
 */
export async function runIngest(
  deps: TurnDeps,
  narrative: string,
  settingText: string,
  log: Logger,
): Promise<void> {
  const loreClient = deps.loreClient ?? deps.controlClient ?? deps.client;

  // 讀 asset-bible.md（不存在則略過）
  let assetBible = "";
  try {
    assetBible = await readFile(path.join(deps.worldDir, "asset-bible.md"), "utf8");
  } catch {
    // 不存在則略過
  }

  // 列出各分類現有 entity IDs，用於 extraction 提示
  const existingIds: Record<string, string[]> = {};
  for (const cat of ["skills", "items", "scenes", "dungeons"] as LoreCategory[]) {
    existingIds[cat] = await listLoreIds(deps.worldDir, cat, log);
  }

  // Step 1: entity extraction
  const extraction = await extractEntities(loreClient, narrative, assetBible, existingIds, log);
  if (!extraction.protagonist_changed && extraction.entities.length === 0) {
    log.debug("ingest: 本回合無實體異動，跳過");
    return;
  }

  // Step 2: 平行 rewrite 各 entity 的 .md 檔
  const touchedByCategory: Record<string, string[]> = {};

  const entityTasks = extraction.entities.map(async (entity) => {
    const loreCat = CATEGORY_TO_LORE[entity.category];
    if (!loreCat) {
      log.warn({ entity }, "ingest: 未知 category，略過");
      return;
    }
    const safeId = sanitizeLoreId(toTraditional(entity.id));
    const existing = await loadLoreFile(deps.worldDir, loreCat, safeId, log);

    // 全新建檔時注入骨架（失敗則略過，骨架是 nice-to-have）
    let scaffold: string | undefined;
    if (!existing) {
      try {
        scaffold = await getTemplate(entity.category, deps.worldDir, path.dirname(deps.worldDir));
      } catch {
        // optional
      }
    }

    const titlePrefix = CATEGORY_TITLE[entity.category] ?? entity.category;
    const docTitle = `${titlePrefix}（${entity.name}）`;
    const content = await callLoreRewrite(
      loreClient,
      settingText,
      narrative,
      docTitle,
      existing,
      entity.category as LoreRewriteCategory,
      log,
      undefined,
      scaffold,
    );
    if (!content) {
      log.warn({ id: safeId }, "ingest Step 2: entity rewrite 失敗，略過");
      return;
    }
    await rewriteLoreFile(deps.worldDir, loreCat, safeId, content, entity.name, log);
    if (!touchedByCategory[loreCat]) touchedByCategory[loreCat] = [];
    touchedByCategory[loreCat].push(safeId);
  });

  // 主角更新（protagonist.md 整檔重寫）
  let protagonistTouched = false;
  const protagonistTask = extraction.protagonist_changed
    ? (async () => {
        const pPath = path.join(deps.worldDir, "characters", "protagonist.md");
        const existing = await readFile(pPath, "utf8").catch(() => "");
        if (!existing) {
          log.warn("ingest: protagonist.md 不存在，略過");
          return;
        }
        const content = await callProtagonistRewrite(loreClient, settingText, narrative, existing, log);
        if (!content) {
          log.warn("ingest: protagonist rewrite 失敗");
          return;
        }
        await writeFile(pPath, content, "utf8");
        protagonistTouched = true;
      })()
    : Promise.resolve();

  await Promise.all([...entityTasks, protagonistTask]);

  // Step 3: 對有更新的每個分類 rewrite wiki.md
  const wikiTasks = Object.entries(touchedByCategory).map(async ([loreCat, touchedIds]) => {
    const cat = loreCat as LoreCategory;
    const wikiPath = path.join(deps.worldDir, cat, "wiki.md");
    const existingWiki = await readFile(wikiPath, "utf8").catch(() => "");

    const touchedContents = await Promise.all(
      touchedIds.map(async (id) => {
        const content = await readFile(
          path.join(deps.worldDir, cat, `${id}.md`),
          "utf8",
        ).catch(() => "");
        return `### ${id}\n${content}`;
      }),
    );

    const prompt = [
      `你是「無限恐怖」世界的分類索引維護者。`,
      `根據以下「更新的實體內容」，更新「${cat}」的分類索引 wiki.md。`,
      `索引格式建議：${WIKI_FORMAT_HINT[cat]}`,
      "規則：保留索引中未被更新的條目；只對本次更新的條目修改或新增對應行；輸出整份 wiki.md 完整內容。",
      existingWiki ? `\n現有 wiki.md：\n${existingWiki}` : "\n（目前無 wiki.md，全新建立）",
      `\n本次更新的實體：\n${touchedContents.join("\n\n")}`,
    ].join("\n");

    let wikiContent = "";
    try {
      for await (const delta of loreClient.streamChat([
        { role: "system", content: prompt },
        { role: "user", content: "請輸出完整新版 wiki.md 內容。" },
      ])) {
        wikiContent += delta;
      }
    } catch (err) {
      log.warn({ err, cat }, "ingest Step 3: wiki rewrite 失敗，略過");
      return;
    }
    if (!wikiContent.trim()) return;
    await mkdir(path.join(deps.worldDir, cat), { recursive: true });
    await writeFile(wikiPath, toTraditional(wikiContent.trim()) + "\n", "utf8");
  });
  await Promise.all(wikiTasks);

  if (Object.keys(touchedByCategory).length > 0 || protagonistTouched) {
    // 語意索引：重新索引有異動的 entity .md 檔
    if (deps.recall) {
      const touchedPaths: string[] = [];
      for (const [loreCat, touchedIds] of Object.entries(touchedByCategory)) {
        for (const id of touchedIds) {
          touchedPaths.push(loreFilePath(deps.worldDir, loreCat as LoreCategory, id));
        }
      }
      if (protagonistTouched) {
        touchedPaths.push(path.join(deps.worldDir, "characters", "protagonist.md"));
      }
      if (touchedPaths.length > 0) {
        await reindexTouchedFiles(deps.recall, deps.worldDir, touchedPaths, log);
      }
    }
    await deps.commit("ingest: 更新實體知識（entity.md / wiki.md）");
  }
}
