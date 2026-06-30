import { writeFile, appendFile, mkdir, readFile, readdir, rename, access } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { loadLoreFile } from "./lore.js";
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

/** 計算 dungeons/<id>/ 底下現有的 log-run-*.md 數量，決定下一個 run 序號 */
async function countLogRuns(dir: string): Promise<number> {
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  return files.filter((f) => /^log-run-\d+\.md$/.test(f)).length;
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
  const safeDungeonId = toTraditional(params.dungeonId.trim());
  const dir = dungeonDir(worldDir, safeDungeonId);
  await mkdir(dir, { recursive: true });

  const runNumber = (await countLogRuns(dir)) + 1;
  const runId = `run-${runNumber}`;
  logger.info({ dungeonId: safeDungeonId, runId }, "進入副本");

  const logFile = path.join(dir, "log.md");
  const header = [
    `# 副本 ${safeDungeonId} · ${runId}（${params.today}）`,
    "",
    `- 進入時角色狀態：${toTraditional(params.protagonistSummary)}`,
    `- 本次目標：${toTraditional(params.goal)}`,
    "",
    "---",
    "",
  ].join("\n");

  await writeFile(logFile, header, "utf8");

  // 首次進入寫 secrets.md（已存在則不覆寫，保住暗線一致）
  const secretsFile = path.join(dir, "secrets.md");
  let secretsExists = false;
  try { await access(secretsFile); secretsExists = true; } catch { /* ENOENT is expected */ }
  if (!secretsExists) {
    logger.debug({ dungeonId: safeDungeonId }, "首次進入副本，寫入隱藏設定 secrets.md");
    await writeFile(
      secretsFile,
      `# 副本隱藏真相（${safeDungeonId}）\n\n> 劇透文件：僅供敘事暗線一致，不可提前揭露給玩家。\n\n${params.secretsText.trim()}\n`,
      "utf8",
    );
  }

  return { dungeonId: safeDungeonId, runId };
}

/**
 * 結算後把當次 log.md rename 成 log-run-N.md（N = 現有 log-run-*.md 數量 + 1）。
 * log.md 不存在時靜默略過（防禦：副本進入前結算或重複結算）。
 */
export async function renameLogAfterSettle(
  worldDir: string,
  dungeonId: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  const dir = dungeonDir(worldDir, dungeonId);
  const logFile = path.join(dir, "log.md");
  const n = (await countLogRuns(dir)) + 1;
  const dest = path.join(dir, `log-run-${n}.md`);
  try {
    await rename(logFile, dest);
    logger.info({ dungeonId, dest }, "副本 log.md rename 完成");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
}

export interface RunEntry {
  date: string;
  title: string;
  body: string;
  playerAction?: string;
}

/** 把回合記錄 append 到 dungeons/<id>/log.md（副本 raw 層，append-only） */
export async function appendLog(
  worldDir: string,
  dungeonId: string,
  runId: string,
  entry: RunEntry,
): Promise<void> {
  const file = path.join(dungeonDir(worldDir, dungeonId), "log.md");
  const playerLine = entry.playerAction?.trim()
    ? `\n> 玩家：${entry.playerAction.trim()}\n`
    : "";
  await appendFile(file, `${playerLine}\n## [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`, "utf8");
}

/** @deprecated 請改用 appendLog */
export const appendRun = appendLog;

/** 讀副本的 wiki（已揭露知識）與 secrets（暗線），缺檔回空字串 */
export async function loadDungeonLore(
  worldDir: string,
  dungeonId: string,
  logger: Logger = defaultLogger,
): Promise<{ wiki: string; secrets: string }> {
  const wiki = await loadLoreFile(worldDir, "dungeons", dungeonId, logger);
  const secretsPath = path.join(worldDir, "dungeons", dungeonId, "secrets.md");
  let secrets = "";
  try {
    secrets = await readFile(secretsPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn({ err, file: secretsPath }, "讀取副本 secrets.md 失敗（非檔案不存在）");
    }
  }
  return { wiki, secrets };
}

/**
 * 列舉已進入的副本 id（dungeons/ 子目錄名）；目錄不存在回 []。
 * 副本進入時以目錄存在為準（log.md 等在目錄內），不依賴 wiki .md 是否已建立。
 */
async function listEnteredDungeonIds(worldDir: string): Promise<string[]> {
  const dungeonsDir = path.join(worldDir, "dungeons");
  try {
    const entries = await readdir(dungeonsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 列舉所有副本 id：已進入的子目錄 + dungeons-index.md 中的公告副本，去重合併。
 * Layer 2 用此列表判斷「重返既有副本」vs「全新副本」，避免把 U-001 造成 new_dungeon。
 */
export async function listDungeonIds(
  worldDir: string,
  _logger?: Logger,
): Promise<string[]> {
  const [entered, announced] = await Promise.all([
    listEnteredDungeonIds(worldDir),
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
 * 從 journal.md 全文抽出指定副本 run 的段落（不含 boundary markers 本身）。
 * dungeonRunId 格式：`<dungeonId>-<runId>`（例如 `命運樞紐-run-1`）。
 * 找不到 start marker → 回空字串；找不到 end marker → 回到檔尾（副本仍在進行）。
 */
export function extractDungeonLog(journalContent: string, dungeonRunId: string): string {
  const startMarker = `<!-- dungeon-start: ${dungeonRunId} `;
  const endMarker = `<!-- dungeon-end: ${dungeonRunId} -->`;
  const startIdx = journalContent.indexOf(startMarker);
  if (startIdx === -1) return "";
  const afterStart = journalContent.indexOf("\n", startIdx);
  if (afterStart === -1) return "";
  const endIdx = journalContent.indexOf(endMarker, afterStart);
  if (endIdx === -1) return journalContent.slice(afterStart + 1).trim();
  return journalContent.slice(afterStart + 1, endIdx).trim();
}
