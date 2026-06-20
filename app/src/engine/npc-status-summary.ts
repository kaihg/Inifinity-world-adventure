import type { ChatMessage, LlmClient } from "../llm/client.js";

/** 移除可能破壞 index.md 表格結構的字元（換行、表格分隔符），並限長防止表格被撐壞 */
function sanitize(value: string): string {
  return value.replace(/[\r\n|]/g, " ").trim().slice(0, 40);
}

export interface SummarizeNpcStatusParams {
  name: string;
  characterMd: string;
  client: LlmClient;
}

/**
 * 用一句話概括角色檔案目前最關鍵的近況，供 characters/index.md 省 context 用的索引表格使用。
 * 設計上用小模型（TurnDeps.characterClient，缺省退回主 client）即可，不需要主敘事模型的推理力。
 * 呼叫失敗或回應為空時回空字串，呼叫端應視為「略過此筆」而非中斷其他筆。
 */
export async function summarizeNpcStatus(params: SummarizeNpcStatusParams): Promise<string> {
  const { name, characterMd, client } = params;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "你是角色狀態摘要器。讀取角色檔案全文，用一句話（15 字以內，繁體中文）概括該角色目前最關鍵的近況，",
        "供省 context 用的索引表格使用。只輸出這一句話本身，不要角色名、不要前言後語、不要 markdown 格式。",
      ].join("\n"),
    },
    { role: "user", content: `角色：${name}\n\n角色檔案：\n${characterMd.trim()}` },
  ];

  let raw = "";
  try {
    for await (const delta of client.streamChat(messages)) raw += delta;
  } catch {
    return "";
  }
  return sanitize(raw.split("\n").find((l) => l.trim()) ?? "");
}
