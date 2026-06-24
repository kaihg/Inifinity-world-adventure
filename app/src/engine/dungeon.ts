import { writeFile, appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { loadLore, ensureSecrets, listLoreIds } from "./lore.js";
import { toTraditional } from "./text/traditionalize.js";

export interface ActiveDungeon {
  dungeonId: string;
  runId: string;
}

/** 解析 now.md「進行中的副本」欄，格式「<id> + <run>」；無/空 → null */
export function parseActiveDungeon(value: string): ActiveDungeon | null {
  const first = value.split("\n")[0].trim();
  if (first === "" || first === "無") return null;
  const m = first.match(/^(.+?)\s*\+\s*(run-\S+)$/);
  if (!m) return null;
  return { dungeonId: m[1].trim(), runId: m[2].trim() };
}

export function formatActiveDungeon(d: ActiveDungeon): string {
  return `${d.dungeonId} + ${d.runId}`;
}

/** 從 log.md 內容推下一個 run 序號（## run-1…run-N 的最大值 +1） */
export function nextRunNumber(logContent: string): number {
  const matches = [...logContent.matchAll(/^## run-(\d+)/gm)];
  const nums = matches.map((m) => Number(m[1]));
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

function dungeonDir(worldDir: string, dungeonId: string): string {
  return path.join(worldDir, "dungeons", dungeonId);
}

export interface EnterDungeonParams {
  dungeonId: string;
  today: string;
  protagonistSummary: string;
  goal: string;
  /** 首次進入該副本時寫入 secrets.md 的隱藏真相（由上層用 LLM 生成後傳入） */
  secretsText: string;
}

/**
 * 進入副本：在 dungeons/<id>/log.md 新增一個 ## run-N 段落（含進入日期/角色摘要/目標），
 * 首次進入該副本時寫 secrets.md（已存在則不覆寫，保住暗線一致；落地邏輯重用 lore.ts，與道具/技能等其他揭露式知識共用）。
 * 不切 git branch；now.md 進行中的副本欄由上層更新。
 */
export async function enterDungeon(
  worldDir: string,
  params: EnterDungeonParams,
  logger: Logger = defaultLogger,
): Promise<ActiveDungeon> {
  const dir = dungeonDir(worldDir, params.dungeonId);
  await mkdir(dir, { recursive: true });

  const logFile = path.join(dir, "log.md");
  let existing = "";
  try {
    existing = await readFile(logFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }

  const runNumber = nextRunNumber(existing);
  const runId = `run-${runNumber}`;
  logger.info({ dungeonId: params.dungeonId, runId }, "進入副本");

  // 動態值（角色摘要、目標）可能含 LLM 產出的簡體，落地前繁體化；模板字串本身已是繁體不需轉
  const header = [
    `## ${runId}（${params.today}）`,
    "",
    `- 進入時角色狀態：${toTraditional(params.protagonistSummary)}`,
    `- 本次目標：${toTraditional(params.goal)}`,
    "",
    "---",
    "",
  ].join("\n");

  if (!existing.trim()) {
    // 首次進入，建立檔案含 h1 標題
    await writeFile(
      logFile,
      `# 副本 ${params.dungeonId} · Log\n\n${header}`,
      "utf8",
    );
  } else {
    await appendFile(logFile, `\n${header}`);
  }

  await ensureSecrets(worldDir, "dungeons", params.dungeonId, params.secretsText, `副本隱藏真相（${params.dungeonId}）`, logger);

  return { dungeonId: params.dungeonId, runId };
}

export interface RunEntry {
  date: string;
  title: string;
  body: string;
}

/** 把回合記錄 append 到 dungeons/<id>/log.md（副本 raw 層，append-only） */
export async function appendLog(
  worldDir: string,
  dungeonId: string,
  runId: string,
  entry: RunEntry,
): Promise<void> {
  const file = path.join(dungeonDir(worldDir, dungeonId), "log.md");
  await appendFile(file, `\n### [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`, "utf8");
}

/** @deprecated 請改用 appendLog */
export const appendRun = appendLog;

/** 讀副本的 wiki（已揭露知識）與 secrets（暗線），缺檔回空字串 */
export async function loadDungeonLore(
  worldDir: string,
  dungeonId: string,
  logger: Logger = defaultLogger,
): Promise<{ wiki: string; secrets: string }> {
  return loadLore(worldDir, "dungeons", dungeonId, logger);
}

/**
 * 列舉所有副本 id：已進入的子目錄 + dungeons-index.md 中的公告副本，去重合併。
 * Layer 2 用此列表判斷「重返既有副本」vs「全新副本」，避免把 U-001 造成 new_dungeon。
 */
export async function listDungeonIds(
  worldDir: string,
  logger: Logger = defaultLogger,
): Promise<string[]> {
  const [entered, announced] = await Promise.all([
    listLoreIds(worldDir, "dungeons", logger),
    listAnnouncedDungeonIds(worldDir),
  ]);
  const merged = new Set([...entered, ...announced]);
  return [...merged];
}

const DUNGEONS_INDEX_PATH = (worldDir: string) =>
  path.join(worldDir, "dungeons-index.md");

const DUNGEONS_INDEX_RE = /^\|\s*([^\s|]+)\s*\|\s*(.+?)\s*\|/;

/**
 * 讀 world/dungeons-index.md，回傳系統已公告但尚未進入的副本 id 列表。
 * 格式：每列 `| <id> | <顯示名稱> |`；檔案不存在回 []。
 */
export async function listAnnouncedDungeonIds(worldDir: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(DUNGEONS_INDEX_PATH(worldDir), "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(DUNGEONS_INDEX_RE);
    if (m && m[1] !== "id" && !/^-+$/.test(m[1])) ids.push(m[1].trim());
  }
  return ids;
}

/**
 * 若 dungeons-index.md 尚未記錄該 id，新增一列。
 * 已進入（建立目錄）的副本無需登記，呼叫端負責判斷。
 */
export async function registerAnnouncedDungeon(
  worldDir: string,
  id: string,
  displayName: string,
): Promise<void> {
  const file = DUNGEONS_INDEX_PATH(worldDir);
  let existing: string[] = [];
  try {
    const raw = await readFile(file, "utf8");
    existing = raw
      .split("\n")
      .map((l) => l.match(DUNGEONS_INDEX_RE)?.[1]?.trim() ?? "")
      .filter(Boolean);
  } catch {
    // 檔案不存在，初始化 header
    await writeFile(
      file,
      "# 副本公告登記（Dungeons Index）\n\n> 系統已公告但尚未進入的副本。進入後由引擎移除。\n\n| id | 顯示名稱 |\n|----|----------|\n",
      "utf8",
    );
  }
  if (!existing.includes(id)) {
    await appendFile(file, `| ${id} | ${displayName} |\n`, "utf8");
  }
}
