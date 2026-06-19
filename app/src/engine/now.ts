import type { NowState } from "./context.js";

export interface NowUpdate {
  date: string; // YYYY-MM-DD
  summary: string;
}

const NOW_HEADER = `# 當前局勢（Now）

> resume 入口：新 session 接劇情先讀這份（覆寫式快照，永遠精簡）。
> 由回合引擎每回合覆寫，不是 append；要回溯更早細節才翻 journal.md / runs/*.md。
`;

/** 把七欄 NowState 序列化成 canonical now.md（覆寫式，引擎擁有此檔） */
export function serializeNow(now: NowState): string {
  return (
    NOW_HEADER +
    "\n" +
    [
      `- 當前篇章：${now.chapter}`,
      `- 此刻場景/地點：${now.scene}`,
      `- 在場同伴/相關 NPC：${now.companions}`,
      `- 進行中的副本：${now.activeDungeon}`,
      `- 未解懸念/伏筆：${now.threads}`,
      `- 主角下一步打算：${now.nextStep}`,
      `- 最後更新：${now.lastUpdated}`,
    ].join("\n") +
    "\n"
  );
}

/** 套用模型提供的局部欄位覆寫，未提供的欄位保留；同時更新「最後更新」 */
export function applyNowChanges(
  current: NowState,
  changes: Partial<Omit<NowState, "lastUpdated">>,
  update: NowUpdate,
): NowState {
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(changes).filter(([, v]) => v !== undefined && v !== ""),
    ),
    lastUpdated: `[${update.date}] ${update.summary}`,
  };
}

const UPDATED_LINE = /^-\s*最後更新：.*$/m;

/**
 * 只覆寫 now.md 的「最後更新」行（lossless：不動其餘欄位與臨時欄位）。
 * Phase 2 的最小覆寫；完整的七欄結構化覆寫在 Phase 3。
 */
export function bumpNowUpdated(md: string, update: NowUpdate): string {
  const line = `- 最後更新：[${update.date}] ${update.summary}`;
  if (UPDATED_LINE.test(md)) {
    return md.replace(UPDATED_LINE, line);
  }
  const sep = md.endsWith("\n") ? "" : "\n";
  return `${md}${sep}${line}\n`;
}
