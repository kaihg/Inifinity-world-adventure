import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { parseNow } from "../context.js";
import { serializeNow } from "../now.js";

export async function generateSecrets(client: LlmClient, settingText: string, dungeonId: string): Promise<string> {
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
