import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import type { Logger } from "../logger.js";
import { serializeNow } from "./now.js";
import type { NowState } from "./context.js";
import { buildProtagonistPrompt, type ProtagonistSeed } from "./protagonist-seed.js";

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
 * 失敗時可能留下半套檔案——呼叫端應在 isWorldInitialized 為 false 時才呼叫，
 * 且失敗就不 commit（見路由層）。
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
