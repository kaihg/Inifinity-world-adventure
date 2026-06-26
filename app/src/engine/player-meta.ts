import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** 墓誌銘索引條目 */
export interface PlayerMetaIndexEntry {
  epitaphId: string;
  worldUuid: string;
  protagonistGeneration: number;
  protagonistName: string;
  endingType: string;
  createdAt: string;
}

// ────────────────────────────────────────────────────────────
// 內部輔助
// ────────────────────────────────────────────────────────────

/** 回傳 meta/player.md 的絕對路徑 */
function playerPath(repoRoot: string): string {
  return path.join(repoRoot, "meta", "player.md");
}

/** 如果路徑存在則回傳 true，否則 false（不拋錯） */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** meta/player.md 的初始 Markdown 內容 */
const INITIAL_PLAYER_MD = `# 玩家歷程紀錄

- 已封存世界數：0
- 已結算主角代數：0

## 墓誌銘索引

| 墓誌銘 ID | 世界 UUID | 主角代數 | 主角姓名 | 結局類型 | 建立日期 |
| --- | --- | --- | --- | --- | --- |
`;

// ────────────────────────────────────────────────────────────
// 公開 API
// ────────────────────────────────────────────────────────────

/**
 * 確保 meta/player.md 與 meta/epitaphs/ 目錄存在。
 * 若 player.md 已存在則不覆蓋（冪等）。
 */
export async function ensurePlayerMeta(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, "meta", "epitaphs"), { recursive: true });
  const pp = playerPath(repoRoot);
  if (!(await pathExists(pp))) {
    await writeFile(pp, INITIAL_PLAYER_MD, "utf8");
  }
}

/**
 * 依「今天日期字串 YYYY-MM-DD」與「主角代數（1-based）」產生墓誌銘 ID。
 * 格式：epi-YYYYMMDD-<代數，最少三位補零>
 * 例：("2026-06-26", 1) → "epi-20260626-001"
 */
/** 數字後綴是跨所有世界的全域單調主角代數，不是每日計數器。 */
export function nextEpitaphId(today: string, protagonistGenerationCount: number): string {
  const datePart = today.replace(/-/g, "");
  const genPart = String(protagonistGenerationCount).padStart(3, "0");
  return `epi-${datePart}-${genPart}`;
}

/**
 * 建立 meta/epitaphs/<epitaphId>/ 目錄並回傳其絕對路徑。
 * 目錄已存在時不拋錯（冪等）。
 */
export async function createEpitaphDir(repoRoot: string, epitaphId: string): Promise<string> {
  const dirPath = path.join(repoRoot, "meta", "epitaphs", epitaphId);
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

/**
 * 讀取 meta/player.md，解析並回傳「已封存世界數」與「已結算主角代數」。
 */
export async function readPlayerMetaCounts(
  repoRoot: string,
): Promise<{ worldHistoryCount: number; protagonistGenerationCount: number }> {
  const md = await readFile(playerPath(repoRoot), "utf8");

  const worldMatch = md.match(/已封存世界數：(\d+)/);
  const genMatch = md.match(/已結算主角代數：(\d+)/);

  if (!worldMatch) {
    throw new Error("player.md 格式錯誤：找不到已封存世界數");
  }
  if (!genMatch) {
    throw new Error("player.md 格式錯誤：找不到已結算主角代數");
  }

  const worldHistoryCount = Number(worldMatch[1]);
  const protagonistGenerationCount = Number(genMatch[1]);

  return { worldHistoryCount, protagonistGenerationCount };
}

/**
 * 以 regex 就地替換 meta/player.md 中的計數值；不整份重寫，保留其餘內容。
 */
// 讀-改-寫的正確性依賴「單一活躍世界序列化」假設（不可有並行 settlement 同時寫入）。
export async function incrementPlayerCounts(
  repoRoot: string,
  counts: { worldHistoryDelta?: number; protagonistGenerationDelta?: number },
): Promise<void> {
  const md = await readFile(playerPath(repoRoot), "utf8");
  const next = md
    .replace(/已封存世界數：(\d+)/, (_m, n) => `已封存世界數：${Number(n) + (counts.worldHistoryDelta ?? 0)}`)
    .replace(
      /已結算主角代數：(\d+)/,
      (_m, n) => `已結算主角代數：${Number(n) + (counts.protagonistGenerationDelta ?? 0)}`,
    );
  await writeFile(playerPath(repoRoot), next, "utf8");
}

/**
 * 在 meta/player.md 的墓誌銘索引表末尾追加一列。
 * 使用 regex 就地附加，不整份重寫。
 */
export async function appendPlayerMetaIndex(repoRoot: string, entry: PlayerMetaIndexEntry): Promise<void> {
  const newRow =
    `| ${entry.epitaphId} | ${entry.worldUuid} | ${entry.protagonistGeneration} | ${entry.protagonistName} | ${entry.endingType} | ${entry.createdAt} |`;

  const md = await readFile(playerPath(repoRoot), "utf8");
  // 在檔案末尾追加新列（確保結尾有換行，不修改其他空白）
  const nextMd = md.endsWith("\n") ? md + newRow + "\n" : md + "\n" + newRow + "\n";
  await writeFile(playerPath(repoRoot), nextMd, "utf8");
}
