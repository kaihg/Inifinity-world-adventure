import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { logger as defaultLogger, type Logger } from "../logger.js";
import {
  loadState,
  parseNow,
  parseProtagonist,
  applyPointsDelta,
  applyProtagonistUpdates,
  appendNpcUpdates,
  applyIndexStatusUpdates,
  type GameState,
} from "./context.js";
import { summarizeNpcStatus } from "./npc-status-summary.js";
import { appendJournal } from "./journal.js";
import { applyNowChanges, serializeNow, bumpNowUpdated } from "./now.js";
import { rollPool } from "./roll.js";
import { createNarrativeSplitter } from "./stream-split.js";
import { parseTurnOutput, type TurnControl } from "./schema.js";
import {
  parseActiveDungeon,
  formatActiveDungeon,
  enterDungeon,
  appendRun,
  loadDungeonLore,
  appendWikiReveals,
} from "./dungeon.js";
import {
  runCharacterPrePass,
  formatIntentsBlock,
  parseCompanionIds,
} from "./character-pre-pass.js";

export interface TurnDeps {
  client: LlmClient;
  characterClient?: LlmClient;
  worldDir: string;
  commit: (message: string) => Promise<boolean>;
  today?: () => string;
  /** 本回合預擲骰池（測試可注入；預設 crypto 真隨機 6 顆 d100） */
  dicePool?: number[];
  /** 未提供時退回共用的預設 logger（測試環境下為 silent） */
  logger?: Logger;
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "warning"; message: string }
  | { type: "auto-advance"; index: number }
  | { type: "transition"; to: "dungeon" | "main-space"; dungeonId?: string }
  | {
      type: "done";
      narrative: string;
      committed: boolean;
      awaitingUserInput: boolean;
      suggestedActions: string[];
      modeTransition: TurnControl["mode_transition"];
      transitionDungeonId?: string;
    };

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function deriveSummary(narrative: string): string {
  const firstLine = narrative.split("\n").find((l) => l.trim()) ?? "回合";
  const oneLine = firstLine.replace(/[#*>`]/g, "").trim();
  return oneLine.length > 40 ? oneLine.slice(0, 40) + "…" : oneLine;
}

async function readBestEffort(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

// ---------- 共用 system prompt 片段 ----------

const OUTPUT_FORMAT_BLOCK = [
  "## 輸出格式（務必遵守）",
  "先輸出要顯示給玩家的敘事散文。敘事結束後另起一行，輸出一行 `===STATE===`，",
  "緊接著輸出**單一 JSON 物件**（不要加程式碼框），欄位：",
  "- state_changes: { now?: {七欄任意子集，鍵用 chapter/scene/companions/activeDungeon/threads/nextStep},",
  "    protagonist_points_delta?: number,",
  "    protagonist_updates?: { attributes?: string[], skills?: string[], items?: string[], buffs?: string[] }",
  "      （只填新增/變化的條目，會附加到對應區塊，不要重複列已有項目）,",
  "    npc_updates?: [{id, update}], wiki_reveals?: [string] }",
  "- rolls: [{desc, value, success?}]（本回合用到的骰值，沒有就空陣列）",
  '- mode_transition: null | "enter_dungeon" | "settle_dungeon"',
  "- transition_dungeon_id / transition_dungeon_goal：配合 enter_dungeon 才填",
  "- awaiting_user_input: boolean —— 純環境/系統旁白/NPC 自行動作、玩家不需做決定時設 false（引擎自動接續）；需要玩家選擇才設 true。",
  "- suggested_actions: string[]、commit_summary: string（一句摘要）",
].join("\n");

function canonicalBlock(state: GameState): string {
  const { now, protagonist } = state;
  return [
    "## 當前局勢（canonical，請保持一致）",
    `- 當前篇章：${now.chapter}`,
    `- 此刻場景/地點：${now.scene}`,
    `- 在場同伴/相關 NPC：${now.companions}`,
    `- 進行中的副本：${now.activeDungeon}`,
    `- 未解懸念/伏筆：${now.threads}`,
    `- 主角下一步打算：${now.nextStep}`,
    `- 主角：${protagonist.name}（積分 ${protagonist.points}）`,
  ].join("\n");
}

export interface BuildMessagesParams {
  settingText: string;
  state: GameState;
  input: string;
  dicePool: number[];
  intentsBlock?: string;
}

/** 主空間回合的對話訊息（純函式，可測試） */
export function buildMainSpaceMessages(params: BuildMessagesParams): ChatMessage[] {
  const { settingText, state, input, dicePool } = params;
  const system = [
    "你是「無限恐怖」世界的敘事引擎，扮演冷酷機械的主控系統與世界本身，",
    "推進主角在「主神空間安全區」（副本之間的安全區）的劇情。",
    "",
    "## 鐵則",
    "- 全程使用繁體中文與台灣用詞。",
    "- 嚴格遵守下方世界設定，不可竄改既定規則或角色屬性/積分數值。",
    "- 不可揭露任何尚未在劇情中揭露的隱藏設定。",
    "- 只敘述主空間互動；若劇情走到系統強制開啟副本，把 mode_transition 設為 enter_dungeon 並填 transition_dungeon_id，不要自行切到副本內部。",
    "- 需要機率判定時，**只能依序取用下方『本回合骰值』**，不可自行編造數字；用到的骰值要在 rolls 回報。",
    "",
    OUTPUT_FORMAT_BLOCK,
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
    "",
    "## 世界設定（玩家可見規則）",
    settingText.trim(),
    "",
    canonicalBlock(state),
    ...(params.intentsBlock ? ["", params.intentsBlock] : []),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: input },
  ];
}

export interface BuildDungeonMessagesParams extends BuildMessagesParams {
  dungeonId: string;
  wiki: string;
  secrets: string;
}

/** 副本回合的對話訊息：額外帶 wiki（已揭露）與 secrets（暗線，嚴禁外洩） */
export function buildDungeonMessages(params: BuildDungeonMessagesParams): ChatMessage[] {
  const { settingText, state, input, dicePool, dungeonId, wiki, secrets } = params;
  const system = [
    `你是「無限恐怖」世界的敘事引擎，主角正在副本「${dungeonId}」內。`,
    "扮演副本世界與主控系統，依規則推進戰鬥/解謎/生存劇情。",
    "",
    "## 鐵則",
    "- 全程使用繁體中文與台灣用詞。",
    "- 嚴格遵守世界設定與副本已揭露事實（wiki），不可矛盾。",
    "- **secrets 是劇透文件：只能用來保持暗線一致，絕不可直接告訴玩家未揭露的真相**；劇情真的揭露時，才把對應內容放進 wiki_reveals。",
    "- 機率判定**只能依序取用下方骰值**，用到要在 rolls 回報。",
    "- 副本達主線目標/死亡/撤退時，把 mode_transition 設為 settle_dungeon。",
    "",
    OUTPUT_FORMAT_BLOCK,
    "",
    `## 本回合骰值（d100，依序取用）：[${dicePool.join(", ")}]`,
    "",
    "## 世界設定（玩家可見規則）",
    settingText.trim(),
    "",
    "## 副本已揭露知識（wiki，可對玩家呈現）",
    wiki.trim() || "（尚無）",
    "",
    "## 副本隱藏真相（secrets，僅供你保持暗線一致，嚴禁直接揭露）",
    secrets.trim() || "（無）",
    "",
    canonicalBlock(state),
    ...(params.intentsBlock ? ["", params.intentsBlock] : []),
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: input },
  ];
}

/**
 * 把本回合有 npc_updates 的角色，用小模型（characterClient，缺省退回主 client）
 * 各自摘要成一句近況，同步進 characters/index.md 的「最近狀態」欄。
 * 不用主敘事模型：這只是省 context 的索引摘要，不需要主敘事的推理力。
 * 單筆摘要失敗只略過該筆，不中斷其他筆、不影響回合本身。
 */
async function syncCharacterIndexStatus(
  deps: TurnDeps,
  npcUpdates: Array<{ id: string; update: string }>,
  log: Logger,
): Promise<void> {
  const summaryClient = deps.characterClient ?? deps.client;
  const entries = await Promise.all(
    npcUpdates.map(async ({ id }): Promise<readonly [string, string] | null> => {
      const characterMd = await readBestEffort(path.join(deps.worldDir, "characters", `${id}.md`));
      if (!characterMd) return null;
      const name = parseProtagonist(characterMd).name || id;
      const status = await summarizeNpcStatus({ name, characterMd, client: summaryClient });
      return status ? [id, status] : null;
    }),
  );
  const statusUpdates = Object.fromEntries(
    entries.filter((e): e is readonly [string, string] => e !== null),
  );
  if (Object.keys(statusUpdates).length === 0) return;

  const indexPath = path.join(deps.worldDir, "characters", "index.md");
  const indexMd = await readBestEffort(indexPath);
  if (!indexMd) return;
  await writeFile(indexPath, applyIndexStatusUpdates(indexMd, statusUpdates), "utf8");
  log.debug({ statusUpdates }, "同步 characters/index.md 近況欄");
}

// ---------- 回合核心 ----------

interface TurnPlan {
  messages: ChatMessage[];
  /** raw 層落地：主空間→journal，副本→runs/<run>.md */
  appendRaw: (entry: { date: string; title: string; body: string }) => Promise<void>;
  /** 額外提煉：副本把 wiki_reveals 寫進 wiki.md */
  distill?: (control: TurnControl, date: string) => Promise<void>;
}

async function* runTurnCore(
  deps: TurnDeps,
  input: string,
  state: GameState,
  dicePool: number[],
  today: string,
  plan: TurnPlan,
  log: Logger,
): AsyncGenerator<TurnEvent> {
  log.debug({ dicePool }, "回合開始");
  const splitter = createNarrativeSplitter();
  for await (const delta of deps.client.streamChat(plan.messages)) {
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
    // 保留完整原始輸出：解析失敗時這是唯一能還原模型實際吐了什麼的線索
    log.error({ err, raw: full }, "結構化輸出解析失敗，本回合僅保留敘事並暫停");
    yield {
      type: "warning",
      message: `結構化輸出解析失敗，本回合僅保留敘事並暫停：${(err as Error).message}`,
    };
    narrative = full.trim();
  }

  if (control && control.rolls.length > 0) {
    log.debug({ rolls: control.rolls }, "本回合擲骰結果");
  }

  const summary = control?.commit_summary || deriveSummary(narrative);

  // 1. raw 層
  const rollsLine =
    control && control.rolls.length > 0
      ? `\n\n擲骰：${control.rolls.map((r) => `${r.desc}=${r.value}${r.success === undefined ? "" : r.success ? "(成功)" : "(失敗)"}`).join("、")}`
      : "";
  const suggestedActions = control?.suggested_actions ?? [];
  const suggestedLine = suggestedActions.length > 0 ? `\n\n建議動作：${suggestedActions.join("、")}` : "";
  await plan.appendRaw({
    date: today,
    title: summary,
    body: `玩家行動：${input}\n骰池：[${dicePool.join(", ")}]\n\n${narrative}${rollsLine}${suggestedLine}`,
  });

  // 2. 提煉頁 now.md
  const nowPath = path.join(deps.worldDir, "now.md");
  if (control) {
    const newNow = applyNowChanges(state.now, control.state_changes.now ?? {}, { date: today, summary });
    await writeFile(nowPath, serializeNow(newNow), "utf8");
  } else {
    const nowMd = await readFile(nowPath, "utf8");
    await writeFile(nowPath, bumpNowUpdated(nowMd, { date: today, summary }), "utf8");
  }

  // 3. 主角狀態（積分 + 屬性/技能/物品/buff 新增項，否則主角的成長不會被記住）
  const delta = control?.state_changes.protagonist_points_delta ?? 0;
  const protagonistUpdates = control?.state_changes.protagonist_updates;
  if (delta || protagonistUpdates) {
    const pPath = path.join(deps.worldDir, "characters", "protagonist.md");
    let pMd = await readFile(pPath, "utf8");
    if (delta) pMd = applyPointsDelta(pMd, delta);
    if (protagonistUpdates) pMd = applyProtagonistUpdates(pMd, protagonistUpdates);
    await writeFile(pPath, pMd, "utf8");
  }

  // 4. NPC 更新（落地到 characters/<id>.md，否則角色長期沒有記憶）
  const npcUpdates = control?.state_changes.npc_updates ?? [];
  if (npcUpdates.length > 0) {
    await appendNpcUpdates(deps.worldDir, npcUpdates, today, log);
    await syncCharacterIndexStatus(deps, npcUpdates, log);
  }

  // 5. 額外提煉（副本 wiki）
  if (control && plan.distill) {
    await plan.distill(control, today);
  }

  // 6. commit
  const committed = await deps.commit(summary);

  log.info(
    {
      committed,
      awaitingUserInput: control?.awaiting_user_input ?? true,
      modeTransition: control?.mode_transition ?? null,
    },
    "回合結束",
  );

  yield {
    type: "done",
    narrative,
    committed,
    awaitingUserInput: control?.awaiting_user_input ?? true,
    suggestedActions,
    modeTransition: control?.mode_transition ?? null,
    transitionDungeonId: control?.transition_dungeon_id || undefined,
  };
}

/**
 * 對在場 NPC 跑角色意圖 pre-pass，回傳 warning events 與格式化後的 intentsBlock。
 * 失敗靜默降級——不 block 回合，但 yield warning 讓前端可觀察。
 */
async function* runPrePassBlock(
  deps: TurnDeps,
  state: GameState,
  input: string,
): AsyncGenerator<TurnEvent, string> {
  const charClient = deps.characterClient ?? deps.client;
  const npcIds = parseCompanionIds(state.now.companions, state.npcs);
  const npcNames = Object.fromEntries(state.npcs.map((n) => [n.id, n.name]));
  if (npcIds.length === 0) return "";

  let intents: import("./character-pre-pass.js").CharacterIntent[];
  try {
    intents = await runCharacterPrePass({
      npcIds,
      scene: state.now.scene,
      playerInput: input,
      worldDir: deps.worldDir,
      client: charClient,
    });
  } catch (err) {
    yield {
      type: "warning" as const,
      message: `character pre-pass 全部失敗：${(err as Error).message}`,
    };
    return "";
  }

  if (intents.length < npcIds.length) {
    const returnedIds = new Set(intents.map((i) => i.id));
    const missing = npcIds.filter((id) => !returnedIds.has(id));
    yield {
      type: "warning" as const,
      message: `character pre-pass 部分失敗，略過：${missing.join(", ")}`,
    };
  }

  return formatIntentsBlock(intents, npcNames);
}

/** 主空間敘事回合 */
export async function* runMainSpaceTurn(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent> {
  const log = (deps.logger ?? defaultLogger).child({ mode: "main-space" });
  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir, log);
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));

  const intentsBlock = yield* runPrePassBlock(deps, state, input);

  yield* runTurnCore(
    deps,
    input,
    state,
    dicePool,
    today,
    {
      messages: buildMainSpaceMessages({ settingText, state, input, dicePool, intentsBlock }),
      appendRaw: (entry) => appendJournal(deps.worldDir, entry),
    },
    log,
  );
}

/** 副本敘事回合（讀當前 now.md 的進行中副本，落地到 runs/*.md、提煉 wiki） */
export async function* runDungeonTurn(deps: TurnDeps, input: string): AsyncGenerator<TurnEvent> {
  const baseLog = deps.logger ?? defaultLogger;
  const today = (deps.today ?? todayISO)();
  const dicePool = deps.dicePool ?? rollPool(6);
  const state = await loadState(deps.worldDir, baseLog);
  const active = parseActiveDungeon(state.now.activeDungeon);
  if (!active) {
    // 不在副本中卻被呼叫 → 退回主空間回合
    yield* runMainSpaceTurn(deps, input);
    return;
  }
  const log = baseLog.child({ mode: "dungeon", dungeonId: active.dungeonId, runId: active.runId });
  const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));
  const lore = await loadDungeonLore(deps.worldDir, active.dungeonId, log);

  const intentsBlock = yield* runPrePassBlock(deps, state, input);

  yield* runTurnCore(
    deps,
    input,
    state,
    dicePool,
    today,
    {
      messages: buildDungeonMessages({
        settingText, state, input, dicePool,
        dungeonId: active.dungeonId, wiki: lore.wiki, secrets: lore.secrets,
        intentsBlock,
      }),
      appendRaw: (entry) => appendRun(deps.worldDir, active.dungeonId, active.runId, entry),
      distill: (control, date) =>
        appendWikiReveals(deps.worldDir, active.dungeonId, control.state_changes.wiki_reveals ?? [], date, log),
    },
    log,
  );
}

const AUTO_CONTINUE_INPUT = "（系統自動推進：延續上一刻，繼續敘事，玩家未介入）";

async function generateSecrets(client: LlmClient, settingText: string, dungeonId: string): Promise<string> {
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
async function setNowActiveDungeon(
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

/**
 * Mode-aware 自動推進迴圈：依 now.md 模式 dispatch 主空間/副本回合；
 * awaiting_user_input=false 時自動接續；mode_transition 觸發進/結算副本（不切 branch）。
 */
export async function* runTurnLoop(
  deps: TurnDeps,
  input: string,
  maxAuto: number,
): AsyncGenerator<TurnEvent> {
  const log = deps.logger ?? defaultLogger;
  const today = (deps.today ?? todayISO)();
  let currentInput = input;

  for (let i = 0; i <= maxAuto; i++) {
    const state = await loadState(deps.worldDir, log);
    const gen = state.mode === "dungeon" ? runDungeonTurn(deps, currentInput) : runMainSpaceTurn(deps, currentInput);

    let done: Extract<TurnEvent, { type: "done" }> | null = null;
    for await (const ev of gen) {
      yield ev;
      if (ev.type === "done") done = ev;
    }
    currentInput = AUTO_CONTINUE_INPUT;
    if (!done) break;

    // 進入副本：生成 secrets、建 run、設 now，再自動接續第一個副本回合
    if (done.modeTransition === "enter_dungeon" && done.transitionDungeonId) {
      log.info({ dungeonId: done.transitionDungeonId }, "觸發 mode_transition：enter_dungeon");
      const settingText = await readBestEffort(path.join(deps.worldDir, "setting.md"));
      const secretsText = await generateSecrets(deps.client, settingText, done.transitionDungeonId);
      const active = await enterDungeon(
        deps.worldDir,
        {
          dungeonId: done.transitionDungeonId,
          today,
          protagonistSummary: `${state.protagonist.name}（積分 ${state.protagonist.points}）`,
          goal: "（待劇情揭露）",
          secretsText,
        },
        log,
      );
      await setNowActiveDungeon(deps.worldDir, formatActiveDungeon(active), {
        date: today,
        summary: `進入副本 ${active.dungeonId}`,
      });
      await deps.commit(`進入副本 ${active.dungeonId} ${active.runId}`);
      yield { type: "transition", to: "dungeon", dungeonId: active.dungeonId };
      if (i === maxAuto) break;
      yield { type: "auto-advance", index: i + 1 };
      continue;
    }

    // 結算副本：清空進行中副本欄，回主空間，交還玩家
    if (done.modeTransition === "settle_dungeon") {
      log.info({ dungeonId: state.now.activeDungeon }, "觸發 mode_transition：settle_dungeon");
      await setNowActiveDungeon(deps.worldDir, "無", { date: today, summary: "副本結算，返回安全區" });
      await deps.commit("副本結算，返回安全區");
      yield { type: "transition", to: "main-space" };
      break;
    }

    if (done.awaitingUserInput) break;
    if (i === maxAuto) break;
    log.debug({ index: i + 1 }, "自動推進到下一回合");
    yield { type: "auto-advance", index: i + 1 };
  }
}
