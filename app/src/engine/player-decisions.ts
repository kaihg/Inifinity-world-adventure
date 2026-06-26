import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

/** 玩家決策記錄的單一條目 */
export interface PlayerDecisionEntry {
  turnId: string;
  protagonistGeneration: number;
  createdAt: string;
  input: string;
}

/** 回傳 worldDir/player-decisions.md 的絕對路徑 */
function decisionsPath(worldDir: string): string {
  return path.join(worldDir, "player-decisions.md");
}

/**
 * 以 append-only 方式把玩家決策條目寫入 world/player-decisions.md。
 * 首次寫入時在最前面加入標頭「# 玩家決策記錄」；後續只追加區塊。
 * 透過 read-or-fallback 方式減少 TOCTOU 風險。
 */
export async function appendPlayerDecision(
  worldDir: string,
  entry: PlayerDecisionEntry,
): Promise<void> {
  const file = decisionsPath(worldDir);
  const block = [
    `## ${entry.turnId}`,
    `- 時間：${entry.createdAt}`,
    `- 主角代數：${entry.protagonistGeneration}`,
    `- 玩家輸入：${entry.input}`,
    "",
  ].join("\n");

  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // 檔案不存在，首次建立
  }
  const prefix = existing === "" ? "# 玩家決策記錄\n\n" : "";
  await appendFile(file, prefix + block, "utf8");
}

/**
 * 讀取 world/player-decisions.md 並解析回所有玩家決策條目。
 * 若檔案不存在則回傳空陣列。
 */
export async function readPlayerDecisions(worldDir: string): Promise<PlayerDecisionEntry[]> {
  const file = decisionsPath(worldDir);
  let md = "";
  try {
    md = await readFile(file, "utf8");
  } catch {
    // 檔案不存在
    return [];
  }

  // 以 ## 開頭的行為邊界切分各區塊
  const sections = md.split(/^(?=## )/m).filter((s) => s.startsWith("## "));

  return sections
    .map((section) => {
      const lines = section.split("\n");
      const turnId = lines[0]?.replace(/^## /, "").trim();

      const createdAtMatch = section.match(/^- 時間：(.+)$/m);
      const genMatch = section.match(/^- 主角代數：(\d+)$/m);
      const inputMatch = section.match(/^- 玩家輸入：(.*)$/m);

      if (!turnId || !createdAtMatch || !genMatch || !inputMatch) return null;

      return {
        turnId,
        protagonistGeneration: Number(genMatch[1]),
        createdAt: createdAtMatch[1].trim(),
        input: inputMatch[1].trim(),
      };
    })
    .filter((e): e is PlayerDecisionEntry => e !== null);
}
