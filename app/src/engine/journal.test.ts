import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendJournal, parseLastTurnRecord } from "./journal.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "iwa-journal-"));
  await writeFile(path.join(dir, "journal.md"), "# 主空間日誌\n\n## [2026-06-18] 既有段\n\n舊內容\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("appendJournal", () => {
  it("以時間戳標題段 append，不動既有內容", async () => {
    await appendJournal(dir, { date: "2026-06-19", title: "新回合", body: "沈奕做了某事。" });
    const md = await readFile(path.join(dir, "journal.md"), "utf8");
    expect(md).toContain("## [2026-06-18] 既有段");
    expect(md).toContain("## [2026-06-19] 新回合");
    expect(md).toContain("沈奕做了某事。");
    // 新段在舊段之後（append-only）
    expect(md.indexOf("新回合")).toBeGreaterThan(md.indexOf("既有段"));
  });
});

describe("parseLastTurnRecord", () => {
  it("還原最後一段的敘事正文，去除玩家行動/骰池前綴與擲骰/建議動作後綴", () => {
    const md = [
      "# 主空間日誌",
      "",
      "## [2026-06-18] 既有段",
      "",
      "玩家行動：舊行動\n骰池：[1, 2]\n\n舊敘事。",
      "",
      "## [2026-06-19] 新回合",
      "",
      "玩家行動：去資訊室\n骰池：[10, 20, 30]\n\n沈奕走進資訊室，葉晴抬頭看他。",
      "",
      "擲骰：偵測=20(失敗)",
      "",
      "建議動作：詢問葉晴、檢查終端機、離開",
      "",
    ].join("\n");

    const result = parseLastTurnRecord(md);
    expect(result).not.toBeNull();
    expect(result!.narrative).toBe("沈奕走進資訊室，葉晴抬頭看他。");
    expect(result!.narrative).not.toContain("玩家行動");
    expect(result!.narrative).not.toContain("擲骰");
    expect(result!.suggestedActions).toEqual(["詢問葉晴", "檢查終端機", "離開"]);
  });

  it("沒有擲骰/建議動作時仍正確還原敘事，suggestedActions 為空陣列", () => {
    const md = "## [2026-06-19] 回合\n\n玩家行動：等待\n骰池：[5]\n\n什麼都沒發生。";
    const result = parseLastTurnRecord(md);
    expect(result).toEqual({ narrative: "什麼都沒發生。", suggestedActions: [] });
  });

  it("檔案沒有任何段落時回 null", () => {
    expect(parseLastTurnRecord("# 空日誌\n\n（尚無記錄）\n")).toBeNull();
  });

  it("舊格式記錄沒有骰池行時仍正確還原（向後相容）", () => {
    const md = "## [2026-06-19] 回合\n\n玩家行動：開始休息\n\n\n\n你沉入休息。";
    const result = parseLastTurnRecord(md);
    expect(result).toEqual({ narrative: "你沉入休息。", suggestedActions: [] });
  });
});
