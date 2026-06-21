import { readFile, writeFile, appendFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";

/**
 * 通用「揭露式知識」儲存：wiki.md（已揭露，可對玩家呈現，累積式）+
 * secrets.md（暗線真相，首次接觸生成一次，之後不覆寫）。
 * 副本（dungeons/<id>）目前用這套；之後道具/技能說明文件要接上同一套關聯規則時，
 * 直接傳對應 category 重用即可，不必各自重新發明落地邏輯。
 */
export type LoreCategory = "dungeons" | "items" | "skills" | "locations";

export interface LoreContent {
  wiki: string;
  secrets: string;
}

/** 檔案不存在（ENOENT）是預期狀況；其他 I/O 錯誤才值得記錄 */
function logUnexpectedReadError(logger: Logger, file: string, err: unknown): void {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
  logger.warn({ err, file }, "讀取 lore 檔案失敗（非檔案不存在）");
}

export function loreDir(worldDir: string, category: LoreCategory, id: string): string {
  return path.join(worldDir, category, id);
}

async function exists(p: string, logger: Logger): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch (err) {
    logUnexpectedReadError(logger, p, err);
    return false;
  }
}

/** 讀某個 lore 對象的 wiki（已揭露知識）與 secrets（暗線），缺檔回空字串 */
export async function loadLore(
  worldDir: string,
  category: LoreCategory,
  id: string,
  logger: Logger = defaultLogger,
): Promise<LoreContent> {
  const dir = loreDir(worldDir, category, id);
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

/**
 * 首次接觸該對象時寫入 secrets.md（已存在則不覆寫，保住暗線一致）。
 * 回傳是否為本次新寫入（false 代表已存在、未變動）。
 */
export async function ensureSecrets(
  worldDir: string,
  category: LoreCategory,
  id: string,
  secretsText: string,
  title: string,
  logger: Logger = defaultLogger,
): Promise<boolean> {
  const dir = loreDir(worldDir, category, id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "secrets.md");
  if (await exists(file, logger)) return false;
  logger.debug({ category, id }, "首次接觸，寫入隱藏設定 secrets.md");
  await writeFile(
    file,
    `# ${title}\n\n> 劇透文件：僅供敘事暗線一致，不可提前揭露給玩家。\n\n${secretsText.trim()}\n`,
    "utf8",
  );
  return true;
}

/** 把已揭露的知識提煉進 wiki.md（append；wiki 不存在則建立） */
export async function appendLoreReveals(
  worldDir: string,
  category: LoreCategory,
  id: string,
  reveals: string[],
  date: string,
  title: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  if (reveals.length === 0) return;
  logger.debug({ category, id, count: reveals.length }, "提煉揭露內容進 wiki.md");
  const dir = loreDir(worldDir, category, id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "wiki.md");
  if (!(await exists(file, logger))) {
    await writeFile(file, `# ${title}\n\n> 累積式：多次接觸間延續。\n`, "utf8");
  }
  const block = `\n## [${date}] 揭露\n\n${reveals.map((r) => `- ${r}`).join("\n")}\n`;
  await appendFile(file, block, "utf8");
}
