import { writeFile, appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { loadLore, ensureSecrets, listLoreIds } from "./lore.js";
import { toTraditional } from "./text/traditionalize.js";

/** 檔案不存在（ENOENT）是預期狀況；其他 I/O 錯誤才值得記錄 */
function logUnexpectedReadError(logger: Logger, file: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
  logger.warn({ err, file }, "讀取副本檔案失敗（非檔案不存在）");
}

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

/** 由既有 run 檔名推下一個 run-id（run-1, run-2…） */
export function nextRunId(existing: string[]): string {
  const nums = existing
    .map((f) => f.match(/^run-(\d+)\.md$/)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `run-${max + 1}`;
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
 * 進入副本：建 runs/<run-id>.md（含進入時間/角色摘要/目標），
 * 首次進入該副本時寫 secrets.md（已存在則不覆寫，保住暗線一致；落地邏輯重用 lore.ts，與道具/技能等其他揭露式知識共用）。
 * 不切 git branch；now.md 進行中的副本欄由上層更新。
 */
export async function enterDungeon(
  worldDir: string,
  params: EnterDungeonParams,
  logger: Logger = defaultLogger,
): Promise<ActiveDungeon> {
  const dir = dungeonDir(worldDir, params.dungeonId);
  const runsDir = path.join(dir, "runs");
  await mkdir(runsDir, { recursive: true });

  let existing: string[] = [];
  try {
    existing = await readdir(runsDir);
  } catch (err) {
    logUnexpectedReadError(logger, runsDir, err);
    existing = [];
  }
  const runId = nextRunId(existing);
  logger.info({ dungeonId: params.dungeonId, runId }, "進入副本");

  // 動態值（角色摘要、目標）可能含 LLM 產出的簡體，落地前繁體化；模板字串本身已是繁體不需轉
  const header = [
    `# 副本 ${params.dungeonId} · ${runId}`,
    "",
    `- 進入時間：[${params.today}]`,
    `- 進入時角色狀態：${toTraditional(params.protagonistSummary)}`,
    `- 本次目標：${toTraditional(params.goal)}`,
    "",
    "---",
    "",
  ].join("\n");
  await writeFile(path.join(runsDir, `${runId}.md`), header, "utf8");

  await ensureSecrets(worldDir, "dungeons", params.dungeonId, params.secretsText, `副本隱藏真相（${params.dungeonId}）`, logger);

  return { dungeonId: params.dungeonId, runId };
}

export interface RunEntry {
  date: string;
  title: string;
  body: string;
}

/** 把回合記錄 append 到 runs/<run-id>.md（副本 raw 層，append-only） */
export async function appendRun(
  worldDir: string,
  dungeonId: string,
  runId: string,
  entry: RunEntry,
): Promise<void> {
  const file = path.join(dungeonDir(worldDir, dungeonId), "runs", `${runId}.md`);
  await appendFile(file, `\n## [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`, "utf8");
}

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
