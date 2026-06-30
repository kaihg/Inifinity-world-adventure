import { appendFile } from "node:fs/promises";
import path from "node:path";

export interface JournalEntry {
  date: string;
  title: string;
  body: string;
  playerAction?: string;
}

/**
 * 把一段回合記錄 append 到 world/journal.md（主空間 raw 層，append-only）。
 * 若有 playerAction，在 ## 段落前加入 > 玩家：行（同一次寫入，決定論）。
 */
export async function appendJournal(worldDir: string, entry: JournalEntry): Promise<void> {
  const playerLine = entry.playerAction?.trim()
    ? `\n> 玩家：${entry.playerAction.trim()}\n`
    : "";
  const section = `${playerLine}\n## [${entry.date}] ${entry.title}\n\n${entry.body.trim()}\n`;
  await appendFile(path.join(worldDir, "journal.md"), section, "utf8");
}

export interface LastTurnRecord {
  narrative: string;
  suggestedActions: string[];
}

/**
 * 還原最後一段回合記錄（給前端重開頁面時還原劇情）。
 * 通用於 journal.md 與 dungeons/<id>/log.md（兩者段落格式相同）。
 */
export function parseLastTurnRecord(md: string): LastTurnRecord | null {
  const headers = [...md.matchAll(/^## \[.*?\] .*$/gm)];
  const last = headers.at(-1);
  if (!last || last.index === undefined) return null;

  let body = md.slice(last.index + last[0].length).trim();
  // 舊格式向下相容：去除 玩家行動：/骰池： 前綴
  body = body.replace(/^玩家行動：.*\n(骰池：.*\n)?\n*/, "");

  let suggestedActions: string[] = [];
  // m flag：$ 匹配行尾，不跨行，避免 HTML comment 進入 suggestedActions
  const suggestedMatch = body.match(/\n\n建議動作：(.+)$/m);
  if (suggestedMatch) {
    suggestedActions = suggestedMatch[1]
      .split("、")
      .map((s) => s.trim())
      .filter(Boolean);
    body = body.slice(0, suggestedMatch.index).trimEnd();
  }

  body = body.replace(/\n\n擲骰：.*$/s, "").trimEnd();
  // 新格式：去除尾端 HTML comment 骰池行（擲骰與建議動作均無時可能殘留）
  body = body.replace(/\n<!-- 骰池：[^\n]*-->/g, "").trimEnd();
  return { narrative: body, suggestedActions };
}
