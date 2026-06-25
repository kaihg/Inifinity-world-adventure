import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import type { Logger } from "../logger.js";
import { serializeNow } from "./now.js";
import type { NowState } from "./context.js";
import { buildProtagonistPrompt, type ProtagonistSeed } from "./protagonist-seed.js";
import { archiveWorld, archiveWorldFiles } from "./archive.js";
import {
  UNINITIALIZED_SETTING_PLACEHOLDER,
  UNINITIALIZED_GM_NOTES_PLACEHOLDER,
} from "./world-status.js";
import { getTemplate } from "./template-loader.js";

/** 把一次性 streamChat 收斂成完整字串（世界級生成都是非串流場景） */
export async function generateText(client: LlmClient, messages: ChatMessage[]): Promise<string> {
  let full = "";
  for await (const d of client.streamChat(messages)) full += d;
  return full.trim();
}

export interface WorldInitInput {
  preferences?: {
    difficulty?: string;
    godPersona?: string;
    protectionRule?: string;
  };
  protagonistSeed?: ProtagonistSeed;
}

const UNSPEC = "（使用者未指定，由你自由發揮）";

/** 起始 now.md 的七欄內容（新世界開局） */
function initialNow(today: string): NowState {
  return {
    chapter: "第一章：開場",
    scene: "主神空間安全區，剛被系統選中",
    companions: "（無）",
    activeDungeon: "無",
    threads: "（待劇情展開）",
    nextStep: "熟悉環境，等待第一個副本公告",
    lastUpdated: `[${today}] 新世界啟用`,
  };
}

/**
 * 生成一個全新世界，把所有檔案寫進 worldDir。呼叫端負責 commit 與清 recall 索引。
 * 所有內容先生成到記憶體，最後才一次性寫檔，故 LLM 生成階段失敗不會留下半套世界；
 * 呼叫端應在 isWorldInitialized 為 false 時才呼叫，且失敗就不 commit（見路由層）。
 */
export async function initWorld(opts: {
  worldDir: string;
  repoRoot: string;
  client: LlmClient;
  input: WorldInitInput;
  today: string;
  logger: Logger;
}): Promise<void> {
  const { worldDir, repoRoot, client, input, today } = opts;
  const pref = input.preferences ?? {};

  // 1) 讀骨架（平行讀，無資料依賴）
  const [settingScaffold, characterScaffold, openingScaffold] = await Promise.all([
    getTemplate("setting", worldDir, repoRoot),
    getTemplate("character", worldDir, repoRoot),
    getTemplate("opening", worldDir, repoRoot),
  ]);

  // 2) setting.md（玩家可見）：先串行生成，後續文件都依賴它
  const settingMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的設定設計師。依玩家偏好，照以下骨架結構填入此世界的具體規則（繁體中文）。" +
        "段落標題（## 開頭）不可改動，每段自由發揮，但必須在本世界全程一致。" +
        "只輸出 markdown 正文，開頭是 `# 世界設定（World Setting）`。\n\n" +
        "骨架如下：\n\n" + settingScaffold,
    },
    {
      role: "user",
      content: [
        `難度：${pref.difficulty?.trim() || UNSPEC}`,
        `主神表面性格：${pref.godPersona?.trim() || UNSPEC}`,
        `新手保護規則草案：${pref.protectionRule?.trim() || UNSPEC}`,
      ].join("\n"),
    },
  ]);

  // 3) protagonist：依賴 settingMd（需知道屬性系統定義），串行生成
  const protagonistMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的角色設計師。照以下骨架結構，填入主角初始資料（繁體中文）。\n" +
        "段落標題不可改動。屬性欄只填數值，不加評語（評語詮釋由世界設定的屬性系統定義）。\n" +
        "屬性數值必須與角色背景設定吻合：對照世界設定的屬性強度表，" +
        "普通人類背景應落在對應區間，但若玩家明確指定特殊角色（如歷史傳奇人物、異能者），" +
        "可按其身份給予相應的較高數值，不強制限制在普通人類範圍。\n" +
        "**物品欄必須為空**：角色剛被傳送進主神空間，現實道具留在原世界，系統尚未發放任何裝備。\n" +
        "只輸出 markdown 正文，開頭是 `# 主角檔案`。\n\n" +
        "骨架如下：\n\n" + characterScaffold,
    },
    {
      role: "user",
      content: `世界設定：\n\n${settingMd}\n\n---\n\n${buildProtagonistPrompt(input.protagonistSeed ?? {})}`,
    },
  ]);

  // 4) gm-notes + opening：皆依賴 settingMd+protagonistMd，平行生成
  const [gmNotesMd, openingMd] = await Promise.all([
    generateText(client, [
      {
        role: "system",
        content:
          "你是「無限恐怖」世界的暗線設計師。依玩家可見的 setting.md，自主編寫世界隱藏真相 gm-notes.md（繁體中文）：" +
          "主神真實動機、世界背後真相、最終目的、暗線伏筆。這是劇透文件，玩家永遠不會直接看到。" +
          "只輸出 markdown 正文，開頭是 `# 世界隱藏真相（GM Notes）`。",
      },
      { role: "user", content: `玩家可見設定如下：\n\n${settingMd}` },
    ]),
    generateText(client, [
      {
        role: "system",
        content:
          "你是「無限恐怖」世界的開場敘事設計師。依玩家可見的 setting.md 與 protagonist.md，" +
          "寫一段開場敘事（繁體中文）：主角在原世界的處境、以及被選中拉入主神空間瞬間的經過。\n" +
          "重要限制：開場敘事只描寫主角離開原世界的那一刻，**不可讓主角帶任何現實道具進入主神空間**；" +
          "若角色有天賦或被動能力，可自然流露，但道具、武器、裝備均留在原世界。" +
          "道具的鑑定與記錄會在進入主神空間後的第一個回合由系統處理，開場不需提及。\n" +
          "依以下骨架的寫作指引發揮，但只輸出敘事正文本身，不要加標題、不要條列、不要前言。\n\n" +
          "骨架（寫作指引）如下：\n\n" + openingScaffold,
      },
      { role: "user", content: `世界設定：\n\n${settingMd}\n\n---\n\n主角檔案：\n\n${protagonistMd}` },
    ]),
  ]);

  // 5) 全部寫入（最後才一次性落地，避免半初始化）
  await mkdir(path.join(worldDir, "characters"), { recursive: true });
  await writeFile(path.join(worldDir, "setting.md"), `${settingMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "gm-notes.md"), `${gmNotesMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "characters", "protagonist.md"), `${protagonistMd}\n`, "utf8");
  await writeFile(
    path.join(worldDir, "characters", "index.md"),
    "# 角色索引（Character Index）\n\n| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |\n|----|------|------|----------|--------------|\n",
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "journal.md"),
    `# 主空間日誌（Journal）\n\n## [${today}] 新世界啟用\n\n${openingMd}\n`,
    "utf8",
  );
  await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");

  const dungeonsDir = path.join(worldDir, "dungeons");
  await rm(dungeonsDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dungeonsDir, { recursive: true });
}

/**
 * 把 world/ 重置回「尚未初始化」佔位狀態。
 * 先整個清空 worldDir 再重建佔位——不是逐檔覆寫白名單，否則遊玩過程動態長出的
 * 檔案（NPC 檔、scenes/、items/、journal_summary.md…）會殘留進新世界。
 * 呼叫端（endWorld）必須在此之前已完成封存複製。
 */
export async function resetWorldToPlaceholder(worldDir: string, today: string): Promise<void> {
  await rm(worldDir, { recursive: true, force: true });
  await mkdir(path.join(worldDir, "characters"), { recursive: true });
  await writeFile(path.join(worldDir, "setting.md"), UNINITIALIZED_SETTING_PLACEHOLDER, "utf8");
  await writeFile(path.join(worldDir, "gm-notes.md"), UNINITIALIZED_GM_NOTES_PLACEHOLDER, "utf8");
  await writeFile(
    path.join(worldDir, "characters", "protagonist.md"),
    "# 主角檔案\n\n> 尚未初始化。\n",
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "characters", "index.md"),
    "# 角色索引（Character Index）\n\n| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |\n|----|------|------|----------|--------------|\n",
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "journal.md"),
    `# 主空間日誌（Journal）\n\n> 尚未初始化。\n`,
    "utf8",
  );
  await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");
  await mkdir(path.join(worldDir, "dungeons"), { recursive: true });
}

/**
 * 封存目前世界：生成終章摘要 → archiveWorld → 寫 summary.md → 重置回佔位。
 * 回傳 archivedTo（相對 repoRoot 的封存目錄）。摘要生成失敗以固定文字降級，不中止封存。
 */
export async function endWorld(opts: {
  repoRoot: string;
  worldDir: string;
  client: LlmClient;
  today: string;
  logger: Logger;
}): Promise<string> {
  const { repoRoot, worldDir, client, today, logger } = opts;
  const readSafe = async (rel: string): Promise<string> => {
    try {
      return await readFile(path.join(worldDir, rel), "utf8");
    } catch {
      return "";
    }
  };

  let summary: string;
  try {
    // 摘要 prompt 只讀 setting + journal/now/protagonist，不讀 gm-notes（避免劇透寫進 archives）
    summary = await generateText(client, [
      {
        role: "system",
        content:
          "你是說書人。依下列已發生的劇情，寫一篇故事終章摘要（繁體中文，數百字）。" +
          "只根據提供的內容，不要杜撰未提及的隱藏真相。",
      },
      {
        role: "user",
        content: [
          `世界設定：\n${await readSafe("setting.md")}`,
          `當前局勢：\n${await readSafe("now.md")}`,
          `主角：\n${await readSafe("characters/protagonist.md")}`,
          `日誌：\n${await readSafe("journal.md")}`,
        ].join("\n\n---\n\n"),
      },
    ]);
    if (!summary) summary = "（摘要生成失敗）";
  } catch (err) {
    logger.warn({ err }, "終章摘要生成失敗，以固定文字降級");
    summary = "（摘要生成失敗）";
  }

  const archivedTo = await archiveWorld(repoRoot, worldDir);
  await writeFile(path.join(repoRoot, archivedTo, "summary.md"), `# 終章摘要\n\n${summary}\n`, "utf8");
  await resetWorldToPlaceholder(worldDir, today);
  return archivedTo;
}

/**
 * 主角換代（保留世界）：封存舊主角相關檔案（含 now.md）→ 寫前任退場摘要 →
 * 生成新主角 → 重置主空間時間線（journal/now/index 的主角列）。
 * 不動 setting.md/gm-notes.md/dungeons/*。回傳封存目錄相對路徑。
 */
export async function replaceProtagonist(opts: {
  repoRoot: string;
  worldDir: string;
  client: LlmClient;
  protagonistSeed: ProtagonistSeed;
  today: string;
  logger: Logger;
}): Promise<string> {
  const { repoRoot, worldDir, client, protagonistSeed, today, logger } = opts;
  const readSafe = async (rel: string): Promise<string> => {
    try { return await readFile(path.join(worldDir, rel), "utf8"); } catch { return ""; }
  };

  // 1) 前任退場摘要（讀 journal/protagonist，不讀 gm-notes）
  let farewell: string;
  try {
    farewell = await generateText(client, [
      { role: "system", content: "你是說書人。為退場的前任主角寫一段簡短退場摘要（繁體中文）。只依提供內容，不杜撰隱藏真相。" },
      { role: "user", content: `主角：\n${await readSafe("characters/protagonist.md")}\n\n日誌：\n${await readSafe("journal.md")}` },
    ]);
    if (!farewell) farewell = "（摘要生成失敗）";
  } catch (err) {
    logger.warn({ err }, "前任主角退場摘要生成失敗，以固定文字降級");
    farewell = "（摘要生成失敗）";
  }

  // 2) 封存舊主角檔（含 now.md 死亡瞬間快照）
  const archivedTo = await archiveWorldFiles(repoRoot, worldDir, [
    "characters/protagonist.md",
    "characters/index.md",
    "journal.md",
    "now.md",
  ]);
  await writeFile(path.join(repoRoot, archivedTo, "summary.md"), `# 前任主角退場摘要\n\n${farewell}\n`, "utf8");

  // 3) 生成新主角
  const protagonistMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的角色設計師。生成接替主角的 protagonist.md（繁體中文）：" +
        "基本資訊、初始積分（一般為 0）、初始屬性、技能、物品欄、Buff/Debuff、新手保護備註。" +
        "可沿用既有世界觀。只輸出 markdown，開頭是 `# 主角檔案`。",
    },
    { role: "user", content: buildProtagonistPrompt(protagonistSeed) },
  ]);

  // 4) 重置主空間時間線（不動 setting/gm-notes/dungeons）
  await writeFile(path.join(worldDir, "characters", "protagonist.md"), `${protagonistMd}\n`, "utf8");
  await writeFile(
    path.join(worldDir, "characters", "index.md"),
    "# 角色索引（Character Index）\n\n| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |\n|----|------|------|----------|--------------|\n",
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "journal.md"),
    `# 主空間日誌（Journal）\n\n## [${today}] 新主角接替\n\n前任主角已退場，新主角接續這個世界。\n`,
    "utf8",
  );
  await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");
  return archivedTo;
}
