import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { loadState, applyPointsDelta, type GameState } from "./context.js";
import { appendJournal } from "./journal.js";
import { applyNowChanges, serializeNow, bumpNowUpdated } from "./now.js";
import { rollPool } from "./roll.js";
import { createNarrativeSplitter } from "./stream-split.js";
import { parseTurnOutput, type TurnControl } from "./schema.js";

export interface TurnDeps {
  client: LlmClient;
  worldDir: string;
  commit: (message: string) => Promise<boolean>;
  today?: () => string;
  /** 本回合預擲骰池（測試可注入；預設 crypto 真隨機 6 顆 d100） */
  dicePool?: number[];
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "warning"; message: string }
  | { type: "auto-advance"; index: number }
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: TurnControl["mode_transition"];
    };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function deriveSummary(narrative: string): string {
  const firstLine = narrative.split("\n").find((l) => l.trim()) ?? "主空間回合";
  const oneLine = firstLine.replace(/[#*>`]/g, "").trim();
  return oneLine.length > 40 ? oneLine.slice(0, 40) + "…" : oneLine;
}

export interface BuildMessagesParams {
  settingText: string;
  state: GameState;
  input: string;
  dicePool: number[];
}

/** 組主空間回合的對話訊息（純函式，可測試） */
export function buildMainSpaceMessages(params: BuildMessagesParams): ChatMessage[] {
  const { settingText, state, input, dicePool } = params;
  const { now, protagonist } = state;

  const system = [
    "你是「無限恐怖」世界的敘事引擎，扮演冷酷機械的主控系統與世界本身，",
    "推進主角在「主神空間安全區」（副本之間的安全區）的劇情。",
    "",
    "## 鐵則",
    "- 全程使用繁體中文與台灣用詞。",
    "- 嚴格遵守下方世界設定，不可竄改既定規則或角色屬性/積分數值。",
    "- 不可揭露任何尚未在劇情中揭露的隱藏設定。",
    "- 只敘述主空間（安全區）的互動；若劇情走到系統強制開啟副本，於敘事中點出徵兆並把 mode_transition 設為 enter_dungeon，不要自行切到副本內部。",
    "- 需要機率判定時，**只能依序取用下方『本回合骰值』**，不可自行編造數字；用到的骰值要在 rolls 回報。",
    "",
    "## 輸出格式（務必遵守）",
    "先輸出要顯示給玩家的敘事散文。敘事結束後另起一行，輸出一行 `===STATE===`，",
    "緊接著輸出**單一 JSON 物件**（不要加程式碼框），欄位：",
    "- state_changes: { now?: {當前局勢七欄的任意子集，鍵用 chapter/scene/companions/activeDungeon/threads/nextStep},",
    "    protagonist_points_delta?: number, npc_updates?: [{id, update}] }",
    "- rolls: [{desc, value, success?}]（本回合用到的骰值，沒有就空陣列）",
    "- mode_transition: null | \"enter_dungeon\" | \"settle_dungeon\"",
    "- awaiting_user_input: boolean —— 若本回合是純環境/系統旁白/NPC 自行動作、玩家不需做決定，設 false（引擎會自動接續下一回合）；需要玩家選擇才設 true。",
    "- suggested_actions: string[] —— 給玩家的建議行動（可空）",
    "- commit_summary: string —— 一句話摘要本回合（給 git/journal 用）",
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
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
 * 跑一個主空間敘事回合：預擲骰 → 串流 LLM（敘事即時轉發、控制區塊內部緩存）→
 * 解析結構化控制 → 決定論落地（now 七欄、protagonist 積分、journal）→ commit。
 * 解析失敗時不重串流（避免畫面與狀態不一致）：保留已串流敘事、最小覆寫時間戳、暫停等玩家。
 */
export async function* runMainSpaceTurn(
  deps: TurnDeps,
  input: string,
): AsyncGenerator<TurnEvent> {
  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir);
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));

  const messages = buildMainSpaceMessages({ settingText, state, input, dicePool });

  const splitter = createNarrativeSplitter();
  for await (const delta of deps.client.streamChat(messages)) {
    const text = splitter.push(delta);
    if (text) yield { type: "delta", text };
  }
  const tail = splitter.flush();
  if (tail) yield { type: "delta", text: tail };

  const full = splitter.full();

  let control: TurnControl | null = null;
  let narrative = "";
  try {
    const parsed = parseTurnOutput(full);
    control = parsed.control;
    narrative = parsed.narrative;
  } catch (err) {
    yield {
      type: "warning",
      message: `結構化輸出解析失敗，本回合僅保留敘事並暫停：${(err as Error).message}`,
    };
    narrative = full.trim();
  }

  const summary = control?.commit_summary || deriveSummary(narrative);

  // 1. raw 層：append journal（含玩家行動、骰池、用到的骰）
  const rollsLine =
    control && control.rolls.length > 0
      ? `\n\n擲骰：${control.rolls.map((r) => `${r.desc}=${r.value}${r.success === undefined ? "" : r.success ? "(成功)" : "(失敗)"}`).join("、")}`
      : "";
  await appendJournal(deps.worldDir, {
    date: today,
    title: summary,
    body: `玩家行動：${input}\n骰池：[${dicePool.join(", ")}]\n\n${narrative}${rollsLine}`,
  });

  // 2. 提煉頁：覆寫 now.md
  const nowPath = path.join(deps.worldDir, "now.md");
  if (control) {
    const newNow = applyNowChanges(state.now, control.state_changes.now ?? {}, {
      date: today,
      summary,
    });
    await writeFile(nowPath, serializeNow(newNow), "utf8");
  } else {
    // 降級：僅最小覆寫時間戳，保留原檔其餘內容
    const nowMd = await readFile(nowPath, "utf8");
    await writeFile(nowPath, bumpNowUpdated(nowMd, { date: today, summary }), "utf8");
  }

  // 3. protagonist 積分變動
  const delta = control?.state_changes.protagonist_points_delta ?? 0;
  if (delta) {
    const pPath = path.join(deps.worldDir, "characters", "protagonist.md");
    const pMd = await readFile(pPath, "utf8");
    await writeFile(pPath, applyPointsDelta(pMd, delta), "utf8");
  }

  // 4. git 層：自動 commit
  const committed = await deps.commit(summary);

  yield {
    type: "done",
    narrative,
    committed,
    // 解析失敗時保守暫停，交還玩家
    awaitingUserInput: control?.awaiting_user_input ?? true,
    suggestedActions: control?.suggested_actions ?? [],
    modeTransition: control?.mode_transition ?? null,
  };
}

const AUTO_CONTINUE_INPUT = "（系統自動推進：延續上一刻，繼續敘事，玩家未介入）";

/**
 * 主空間回合的自動推進迴圈：玩家送一次輸入後，只要回合回報
 * awaitingUserInput=false（純環境/旁白/NPC 自行動作），就自動接續下一回合，
 * 直到需要玩家決定、出現 mode_transition、或達 maxAuto 上限。解決手動「繼續」。
 */
export async function* runMainSpaceTurnLoop(
  deps: TurnDeps,
  input: string,
  maxAuto: number,
): AsyncGenerator<TurnEvent> {
  let currentInput = input;
  for (let i = 0; i <= maxAuto; i++) {
    let done: Extract<TurnEvent, { type: "done" }> | null = null;
    for await (const ev of runMainSpaceTurn(deps, currentInput)) {
      yield ev;
      if (ev.type === "done") done = ev;
    }
    if (!done || done.awaitingUserInput || done.modeTransition) break;
    if (i === maxAuto) break;
    yield { type: "auto-advance", index: i + 1 };
    currentInput = AUTO_CONTINUE_INPUT;
  }
}
