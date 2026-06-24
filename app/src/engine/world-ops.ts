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

/** 把一次性 streamChat 收斂成完整字串（世界級生成都是非串流場景） */
export async function generateText(client: LlmClient, messages: ChatMessage[]): Promise<string> {
  let full = "";
  for await (const d of client.streamChat(messages)) full += d;
  return full.trim();
}

export interface WorldInitInput {
  preferences?: {
    tone?: string;
    horrorIntensity?: string;
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
  client: LlmClient;
  input: WorldInitInput;
  today: string;
  logger: Logger;
}): Promise<void> {
  const { worldDir, client, input, today } = opts;
  const pref = input.preferences ?? {};

  // 1) setting.md（玩家可見）
  const settingMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的設定設計師。依玩家偏好生成玩家可見的世界設定 setting.md（繁體中文）。" +
        "必須包含：主控系統表面樣貌、世界基調、副本機制、新手保護規則、主空間規則、當前篇章。" +
        "只輸出 markdown 正文，開頭是 `# 世界設定（World Setting）`。",
    },
    {
      role: "user",
      content: [
        `基調/可參考作品：${pref.tone?.trim() || UNSPEC}`,
        `恐怖/驚悚強度：${pref.horrorIntensity?.trim() || UNSPEC}`,
        `主神表面性格：${pref.godPersona?.trim() || UNSPEC}`,
        `新手保護規則草案：${pref.protectionRule?.trim() || UNSPEC}`,
      ].join("\n"),
    },
  ]);

  // 2) gm-notes.md（隱藏真相）——只讀 setting.md 結果，不讀玩家原始偏好逐字稿
  const gmNotesMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的暗線設計師。依玩家可見的 setting.md，自主編寫世界隱藏真相 gm-notes.md（繁體中文）：" +
        "主神真實動機、世界背後真相、最終目的、暗線伏筆。這是劇透文件，玩家永遠不會直接看到。" +
        "只輸出 markdown 正文，開頭是 `# 世界隱藏真相（GM Notes）`。",
    },
    { role: "user", content: `玩家可見設定如下：\n\n${settingMd}` },
  ]);

  // 3) protagonist.md
  const protagonistMd = await generateText(client, [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的角色設計師。生成主角檔案 protagonist.md（繁體中文）：" +
        "基本資訊、初始積分（一般為 0）、初始屬性、技能（通常無）、物品欄、Buff/Debuff、新手保護備註。" +
        "只輸出 markdown 正文，開頭是 `# 主角檔案`。",
    },
    { role: "user", content: buildProtagonistPrompt(input.protagonistSeed ?? {}) },
  ]);

  // 4) 全部寫入（最後才一次性落地，避免半初始化）
  await mkdir(path.join(worldDir, "characters"), { recursive: true });
  await writeFile(path.join(worldDir, "setting.md"), `${settingMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "gm-notes.md"), `${gmNotesMd}\n`, "utf8");
  await writeFile(path.join(worldDir, "characters", "protagonist.md"), `${protagonistMd}\n`, "utf8");
  await writeFile(
    path.join(worldDir, "characters", "index.md"),
    [
      "# 角色索引（Character Index）",
      "",
      "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
      "|----|------|------|----------|--------------|",
      "| protagonist | 主角 | 主角 | 新世界開局 | - |",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(worldDir, "journal.md"),
    `# 主空間日誌（Journal）\n\n## [${today}] 新世界啟用\n\n新世界建立，主角剛被系統選中。\n`,
    "utf8",
  );
  await writeFile(path.join(worldDir, "now.md"), serializeNow(initialNow(today)), "utf8");

  // 清空 dungeons/（若有殘留）
  const dungeonsDir = path.join(worldDir, "dungeons");
  await rm(dungeonsDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dungeonsDir, { recursive: true });
}

/** 把 world/ 重置回「尚未初始化」佔位狀態（覆寫式） */
export async function resetWorldToPlaceholder(worldDir: string, today: string): Promise<void> {
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
  const dungeonsDir = path.join(worldDir, "dungeons");
  await rm(dungeonsDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dungeonsDir, { recursive: true });
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
    [
      "# 角色索引（Character Index）",
      "",
      "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
      "|----|------|------|----------|--------------|",
      "| protagonist | 新主角 | 主角 | 接替前任，新開局 | - |",
      "",
    ].join("\n"),
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
