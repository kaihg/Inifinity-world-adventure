import { readFile, writeFile, appendFile, mkdir, readdir, access } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";

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

async function exists(p: string, logger: Logger = defaultLogger): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch (err) {
    logUnexpectedReadError(logger, p, err);
    return false;
  }
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
 * 首次進入該副本時寫 secrets.md（已存在則不覆寫，保住暗線一致）。
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

  const header = [
    `# 副本 ${params.dungeonId} · ${runId}`,
    "",
    `- 進入時間：[${params.today}]`,
    `- 進入時角色狀態：${params.protagonistSummary}`,
    `- 本次目標：${params.goal}`,
    "",
    "---",
    "",
  ].join("\n");
  await writeFile(path.join(runsDir, `${runId}.md`), header, "utf8");

  const secretsPath = path.join(dir, "secrets.md");
  if (!(await exists(secretsPath, logger))) {
    logger.debug({ dungeonId: params.dungeonId }, "首次進入，寫入隱藏設定 secrets.md");
    await writeFile(
      secretsPath,
      `# 副本隱藏真相（${params.dungeonId}）\n\n> 劇透文件：僅供敘事暗線一致，不可提前揭露給玩家。\n\n${params.secretsText.trim()}\n`,
      "utf8",
    );
  }

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
  const dir = dungeonDir(worldDir, dungeonId);
  const read = async (name: string): Promise<string> => {
    const file = path.join(dir, name);
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      logUnexpectedReadError(logger, file, err);
      return "";
    }
  };
  return { wiki: await read("wiki.md"), secrets: await read("secrets.md") };
}

/** 把本回合已揭露的知識提煉進 wiki.md（append；wiki 不存在則建立） */
export async function appendWikiReveals(
  worldDir: string,
  dungeonId: string,
  reveals: string[],
  date: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  if (reveals.length === 0) return;
  logger.debug({ dungeonId, count: reveals.length }, "提煉 wiki_reveals 進 wiki.md");
  const file = path.join(dungeonDir(worldDir, dungeonId), "wiki.md");
  if (!(await exists(file, logger))) {
    await writeFile(
      file,
      `# 副本 ${dungeonId} · 已揭露知識（Wiki）\n\n> 累積式：多次進入間延續。raw 流水帳在 runs/*.md。\n`,
      "utf8",
    );
  }
  const block = `\n## [${date}] 揭露\n\n${reveals.map((r) => `- ${r}`).join("\n")}\n`;
  await appendFile(file, block, "utf8");
}

/** 列舉 world/dungeons/ 下所有副本子目錄名（id）；dungeons/ 不存在回 [] */
export async function listDungeonIds(
  worldDir: string,
  logger: Logger = defaultLogger,
): Promise<string[]> {
  const dir = path.join(worldDir, "dungeons");
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    logUnexpectedReadError(logger, dir, err);
    return [];
  }
}
