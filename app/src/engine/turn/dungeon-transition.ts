import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { parseNow } from "../context.js";
import { serializeNow } from "../now.js";

export async function generateSecrets(
  client: LlmClient,
  settingText: string,
  dungeonId: string,
  secretsTemplate: string,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "你是「無限恐怖」世界的副本設計者。按以下骨架格式，為指定副本填入隱藏真相（繁體中文）。\n" +
        "這是劇透文件，玩家永遠不會直接看到，只供敘事暗線一致。\n" +
        "只輸出從 `## ` 開頭的段落正文，不含文件標題行（`# `）或 `>` 備注行。\n" +
        "移除骨架中所有 HTML 註解（`<!-- ... -->`），只保留填入的實際內容。\n" +
        "段落標題（`## `）不可改動，不新增也不刪減段落。\n\n" +
        "【生成範圍約束（嚴格遵守）】\n" +
        "1. 素材只能來自該副本所在的原始 IP 設定（例如生化危機副本圍繞病毒學、Umbrella 歷史、原著角色的真實動機）。\n" +
        "2. 禁止在副本 secrets 引入跨副本的元資訊：主神真實動機、執行者制度的起源/弱點、能反噬主神的方法——這些屬於世界層（gm-notes.md）的責任。\n" +
        "3. 副本 secrets 只管該副本自己的圈子：特定場所的物理/生物秘密、在場 NPC 的個人隱情與真實目標、副本機關的運作原理。\n" +
        "4. 即使是第一個副本，也不應揭示能打破整個執行者制度或消滅主神的路徑——那是整部故事後期才可能觸及的內容。\n\n" +
        "世界設定：\n" + settingText.trim() + "\n\n" +
        "骨架如下：\n\n" + secretsTemplate.trim(),
    },
    { role: "user", content: `副本 id：${dungeonId}。請生成其隱藏真相。` },
  ];
  let full = "";
  for await (const d of client.streamChat(messages)) full += d;
  return full.trim() || "（生成失敗，待補）";
}

/**
 * 進入副本時在 journal.md 寫入起始邊界標記，供結算時從 journal 過濾副本段落。
 * dungeonRunId 格式：`<dungeonId>-<runId>`（例如 `命運樞紐-run-1`）。
 */
export async function appendDungeonStartMarker(
  worldDir: string,
  dungeonRunId: string,
  isoTimestamp: string,
): Promise<void> {
  await appendFile(
    path.join(worldDir, "journal.md"),
    `\n<!-- dungeon-start: ${dungeonRunId} ${isoTimestamp} -->\n`,
    "utf8",
  );
}

/**
 * 結算副本時在 journal.md 寫入結束邊界標記。
 */
export async function appendDungeonEndMarker(
  worldDir: string,
  dungeonRunId: string,
): Promise<void> {
  await appendFile(
    path.join(worldDir, "journal.md"),
    `\n<!-- dungeon-end: ${dungeonRunId} -->\n`,
    "utf8",
  );
}

/** 覆寫 now.md 的進行中副本欄並更新時間戳 */
export async function setNowActiveDungeon(
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
