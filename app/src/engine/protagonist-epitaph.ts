import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmClient } from "../llm/client.js";
import type { Logger } from "../logger.js";
import {
  ensurePlayerMeta,
  nextEpitaphId,
  createEpitaphDir,
  incrementPlayerCounts,
  appendPlayerMetaIndex,
} from "./player-meta.js";
import { readWorldUuid } from "./world-id.js";
import { generateText } from "./world-ops.js";

export interface SettleProtagonistOpts {
  repoRoot: string;
  worldDir: string;
  client: LlmClient;
  logger: Logger;
  today: string;
  endingType: "死亡" | "主動封存" | "隨世界結束";
  protagonistGeneration: number;
}

/**
 * 從主角檔案中萃取姓名（第一個「姓名：」後的值）。
 * 找不到時回傳「（未知）」。
 */
function extractProtagonistName(protagonistMd: string): string {
  const match = protagonistMd.match(/姓名[:：]\s*(.+)/);
  return match ? match[1].trim() : "（未知）";
}

/**
 * 把 journal.md / protagonist.md 複製（或寫入佔位）到 epitaphDir 中。
 */
async function snapshotWorldFiles(
  worldDir: string,
  epitaphDir: string,
): Promise<{ protagonistMd: string; journalMd: string }> {
  const journalSrc = path.join(worldDir, "journal.md");
  const protagonistSrc = path.join(worldDir, "characters", "protagonist.md");
  const journalDest = path.join(epitaphDir, "journal.md");
  const protagonistDest = path.join(epitaphDir, "protagonist.md");

  let journalMd: string;
  let protagonistMd: string;

  try {
    journalMd = await readFile(journalSrc, "utf8");
    await writeFile(journalDest, journalMd, "utf8");
  } catch {
    journalMd = "# 主空間日誌（Journal）\n\n（無日誌記錄）\n";
    await writeFile(journalDest, journalMd, "utf8");
  }

  try {
    protagonistMd = await readFile(protagonistSrc, "utf8");
    await writeFile(protagonistDest, protagonistMd, "utf8");
  } catch {
    protagonistMd = "# 主角檔案\n\n（無主角記錄）\n";
    await writeFile(protagonistDest, protagonistMd, "utf8");
  }

  return { protagonistMd, journalMd };
}

/**
 * 呼叫 LLM 生成一段墓誌銘評語；失敗時降級回靜態佔位文字。
 */
async function generateEpitaphText(
  client: LlmClient,
  protagonistMd: string,
  journalMd: string,
  logger: Logger,
): Promise<string> {
  try {
    const text = await generateText(client, [
      {
        role: "system",
        content:
          "你是「無限恐怖」世界的主神。依主角檔案與日誌，為這位退場的主角寫一段簡短的主神評語（墓誌銘）。" +
          "繁體中文，三十字以內，語氣神秘。只輸出評語本文，不加任何標題或前言。",
      },
      {
        role: "user",
        content: `主角檔案：\n\n${protagonistMd}\n\n---\n\n日誌：\n\n${journalMd}`,
      },
    ]);
    return text || "（評語生成失敗）";
  } catch (err) {
    logger.warn({ err }, "墓誌銘評語生成失敗，以固定文字降級");
    return "（評語生成失敗）";
  }
}

/**
 * 渲染 epitaph.md 的 Markdown 內容。
 */
function renderEpitaphMd(opts: {
  epitaphId: string;
  worldUuid: string;
  protagonistName: string;
  protagonistGeneration: number;
  endingType: string;
  epitaphText: string;
  createdAt: string;
}): string {
  return [
    `# 墓誌銘：${opts.epitaphId}`,
    "",
    `- **世界 UUID**：${opts.worldUuid}`,
    `- **主角代數**：${opts.protagonistGeneration}`,
    `- **主角姓名**：${opts.protagonistName}`,
    `- **結局類型**：${opts.endingType}`,
    `- **建立日期**：${opts.createdAt}`,
    "",
    "## 主神評語",
    "",
    opts.epitaphText,
    "",
  ].join("\n");
}

/**
 * 結算一個退場主角：
 * 1. 確保 meta/player.md 存在
 * 2. 讀取 world UUID
 * 3. 產生 epitaphId 並建立目錄
 * 4. 快照 journal.md / protagonist.md（不存在時寫佔位）
 * 5. 呼叫 LLM 生成評語（失敗時降級）
 * 6. 寫入 epitaph.md
 * 7. 更新 meta/player.md 計數與索引
 * 8. 回傳 { epitaphId, epitaphDir }
 */
export async function settleProtagonist(
  opts: SettleProtagonistOpts,
): Promise<{ epitaphId: string; epitaphDir: string }> {
  const { repoRoot, worldDir, client, logger, today, endingType, protagonistGeneration } = opts;

  // 1) 確保 meta/player.md 存在
  await ensurePlayerMeta(repoRoot);

  // 2) 讀取世界 UUID（找不到時用 "unknown"）
  let worldUuid: string;
  try {
    worldUuid = await readWorldUuid(worldDir);
  } catch {
    worldUuid = "unknown";
  }

  // 3) 產生 epitaphId 與目錄
  const epitaphId = nextEpitaphId(today, protagonistGeneration);
  const epitaphDir = await createEpitaphDir(repoRoot, epitaphId);

  // 4) 快照 journal / protagonist
  const { protagonistMd, journalMd } = await snapshotWorldFiles(worldDir, epitaphDir);

  // 5) LLM 生成評語（失敗時降級）
  const epitaphText = await generateEpitaphText(client, protagonistMd, journalMd, logger);

  // 6) 寫入 epitaph.md
  const protagonistName = extractProtagonistName(protagonistMd);
  const createdAt = today;
  const epitaphContent = renderEpitaphMd({
    epitaphId,
    worldUuid,
    protagonistName,
    protagonistGeneration,
    endingType,
    epitaphText,
    createdAt,
  });
  await writeFile(path.join(epitaphDir, "epitaph.md"), epitaphContent, "utf8");

  // 7) 更新計數與索引
  await incrementPlayerCounts(repoRoot, { protagonistGenerationDelta: 1 });
  await appendPlayerMetaIndex(repoRoot, {
    epitaphId,
    worldUuid,
    protagonistGeneration,
    protagonistName,
    endingType,
    createdAt,
  });

  return { epitaphId, epitaphDir };
}
