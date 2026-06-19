import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmClient, ChatMessage } from "../llm/client.js";

export interface CharacterIntent {
  id: string;
  stance: string;
  intent: string;
  tone: string;
}

export interface CharacterPrePassParams {
  npcIds: string[];
  scene: string;
  playerInput: string;
  worldDir: string;
  client: LlmClient;
}

const IntentSchema = z.object({
  stance: z.string().min(1),
  intent: z.string().min(1),
  tone: z.string().min(1),
});

async function fetchIntent(
  id: string,
  characterMd: string,
  scene: string,
  playerInput: string,
  client: LlmClient,
): Promise<CharacterIntent | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是角色意圖分析器。根據角色檔案與當前場景，輸出該角色在本回合的立場、意圖、語氣。",
        "只輸出單一 JSON 物件，不要前言或後語。格式：",
        '{ "stance": "一句話描述立場", "intent": "一句話描述意圖", "tone": "語氣標籤" }',
        "",
        "## 角色檔案",
        characterMd.trim(),
      ].join("\n"),
    },
    {
      role: "user",
      content: `當前場景：${scene}\n玩家行動：${playerInput}`,
    },
  ];

  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = IntentSchema.parse(JSON.parse(raw.slice(start, end + 1)));
    return { id, ...parsed };
  } catch {
    return null;
  }
}

/** 對在場 NPC 並行發意圖 call；缺角色檔或解析失敗的 NPC 靜默略過 */
export async function runCharacterPrePass(
  params: CharacterPrePassParams,
): Promise<CharacterIntent[]> {
  const { npcIds, scene, playerInput, worldDir, client } = params;

  const results = await Promise.all(
    npcIds.map(async (id): Promise<CharacterIntent | null> => {
      const filePath = path.join(worldDir, "characters", `${id}.md`);
      let characterMd: string;
      try {
        characterMd = await readFile(filePath, "utf8");
      } catch {
        return null;
      }
      return fetchIntent(id, characterMd, scene, playerInput, client);
    }),
  );

  return results.filter((r): r is CharacterIntent => r !== null);
}

/** 把 CharacterIntent[] 格式化為注入 system prompt 的區塊 */
export function formatIntentsBlock(
  intents: CharacterIntent[],
  npcNames: Record<string, string>,
): string {
  if (intents.length === 0) return "";
  const lines = [
    "## 在場角色本回合意圖（pre-pass 生成，必須遵守）",
  ];
  for (const { id, stance, intent, tone } of intents) {
    const display = npcNames[id] ? `${npcNames[id]}（${id}）` : id;
    lines.push(`### ${display}`, `- 立場：${stance}`, `- 意圖：${intent}`, `- 語氣：${tone}`, "");
  }
  return lines.join("\n").trimEnd();
}
