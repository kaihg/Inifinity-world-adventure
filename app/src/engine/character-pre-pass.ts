import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LlmClient, ChatMessage } from "../llm/client.js";

/** 把 intent 值中可能破壞 Markdown 結構的字元移除，防止 prompt injection */
function sanitizeIntentValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/^#+\s*/gm, "");
}

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
    // 用 regex 找第一個完整 JSON 物件，比 lastIndexOf 更能應對值中含括號的情況
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = IntentSchema.parse(JSON.parse(match[0]));
    return {
      id,
      stance: sanitizeIntentValue(parsed.stance),
      intent: sanitizeIntentValue(parsed.intent),
      tone: sanitizeIntentValue(parsed.tone),
    };
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
      // 防止路徑穿越：只允許英數字、連字號、底線、點（不含路徑分隔符）
      if (!/^[\w.-]+$/.test(id)) return null;
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

/**
 * 從 now.companions 欄位文字解析在場 NPC 的 ID 列表。
 * 先對照 state.npcs 的 name→id 對應表，把提到的名稱轉為 ID；
 * 找不到對應 ID 的名稱靜默忽略（可能是主敘事提到的路人）。
 */
export function parseCompanionIds(
  companionsText: string,
  npcs: Array<{ id: string; name: string }>,
): string[] {
  const nameToId = new Map(npcs.map((n) => [n.name, n.id]));

  // 把逗號與換行都當分隔符，同時處理「名稱（id）」格式取括號前的名稱
  const tokens = companionsText
    .split(/[\n,]/)
    .map((token) =>
      token
        .replace(/^[\d.]+\s*/, "")   // 移除數字序號「1. 」
        .replace(/^[-*]\s*/, "")     // 移除 markdown bullet
        .replace(/（[^）]*）$/, "")  // 移除括號後綴「（linsiyu）」
        .trim(),
    )
    .filter((name) => name.length > 0);

  // 去重後對應 id
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const name of tokens) {
    const id = nameToId.get(name);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
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
