import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { loadState, type GameState } from "./context.js";
import { appendJournal } from "./journal.js";
import { bumpNowUpdated } from "./now.js";

export interface TurnDeps {
  client: LlmClient;
  worldDir: string;
  /** 注入的 git 提交（回傳是否真的有 commit） */
  commit: (message: string) => Promise<boolean>;
  /** 可注入的今日日期（測試用），格式 YYYY-MM-DD */
  today?: () => string;
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "done"; narrative: string; committed: boolean };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 取敘事第一句當作 journal 標題 / commit 摘要（單行、截斷） */
function deriveSummary(narrative: string): string {
  const firstLine = narrative.split("\n").find((l) => l.trim()) ?? "主空間回合";
  const oneLine = firstLine.replace(/[#*>`]/g, "").trim();
  return oneLine.length > 40 ? oneLine.slice(0, 40) + "…" : oneLine;
}

export interface BuildMessagesParams {
  settingText: string;
  state: GameState;
  input: string;
}

/** 組主空間回合的對話訊息（純函式，可測試） */
export function buildMainSpaceMessages(params: BuildMessagesParams): ChatMessage[] {
  const { settingText, state, input } = params;
  const { now, protagonist } = state;

  const system = [
    "你是「無限恐怖」世界的敘事引擎，扮演冷酷機械的主控系統與世界本身，",
    "推進主角在「主神空間安全區」（副本之間的安全區）的劇情。",
    "",
    "## 鐵則",
    "- 全程使用繁體中文與台灣用詞。",
    "- 嚴格遵守下方世界設定，不可竄改既定規則或角色屬性/積分數值。",
    "- 不可揭露任何尚未在劇情中揭露的隱藏設定。",
    "- 只敘述主空間（安全區）的互動；若劇情走到系統強制開啟副本，於敘事中點出徵兆即可，不要自行切到副本內部。",
    "",
    "## 世界設定（玩家可見規則）",
    settingText.trim(),
    "",
    "## 當前局勢（canonical，請保持一致）",
    `- 當前篇章：${now.chapter}`,
    `- 此刻場景/地點：${now.scene}`,
    `- 在場同伴/相關 NPC：${now.companions}`,
    `- 進行中的副本：${now.activeDungeon}`,
    `- 未解懸念/伏筆：${now.threads}`,
    `- 主角下一步打算：${now.nextStep}`,
    `- 主角：${protagonist.name}（積分 ${protagonist.points}）`,
    "",
    "依玩家的行動，給出一段連貫、有畫面感的敘事回應。",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: input },
  ];
}

async function readBestEffort(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * 跑一個主空間敘事回合：串流 LLM → 落地 journal（raw）→ 覆寫 now 時間戳 → commit。
 * Phase 2 為最小版（無結構化輸出、無自動推進、無 roll）。
 */
export async function* runMainSpaceTurn(
  deps: TurnDeps,
  input: string,
): AsyncGenerator<TurnEvent> {
  const today = (deps.today ?? todayISO)();
  const state = await loadState(deps.worldDir);
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));

  const messages = buildMainSpaceMessages({ settingText, state, input });

  let narrative = "";
  for await (const delta of deps.client.streamChat(messages)) {
    narrative += delta;
    yield { type: "delta", text: delta };
  }

  const summary = deriveSummary(narrative);

  // 1. raw 層：append journal
  await appendJournal(deps.worldDir, {
    date: today,
    title: summary,
    body: `玩家行動：${input}\n\n${narrative}`,
  });

  // 2. 提煉頁：最小覆寫 now.md 時間戳（完整七欄覆寫在 Phase 3）
  const nowPath = path.join(deps.worldDir, "now.md");
  const nowMd = await readFile(nowPath, "utf8");
  await writeFile(nowPath, bumpNowUpdated(nowMd, { date: today, summary }), "utf8");

  // 3. git 層：自動 commit
  const committed = await deps.commit(summary);

  yield { type: "done", narrative, committed };
}
