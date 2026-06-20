import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendJournal, parseLastTurnRecord, readLastTurnRecord } from "./journal.js";

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
      `建議動作：${JSON.stringify(["詢問葉晴", "檢查終端機", "離開"])}`,
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

  it("玩家行動為多行文字時仍正確定位骰池行，不洩漏殘留行進敘事", () => {
    const md =
      "## [2026-06-19] 回合\n\n玩家行動：第一行\n第二行\n骰池：[1, 2, 3]\n\n真正的敘事內容。";
    const result = parseLastTurnRecord(md);
    expect(result!.narrative).toBe("真正的敘事內容。");
    expect(result!.narrative).not.toContain("骰池");
    expect(result!.narrative).not.toContain("第二行");
  });

  it("建議動作的動作文字本身含分隔字元「、」時，JSON 編碼往返不被拆散", () => {
    const md = `## [2026-06-19] 回合\n\n玩家行動：等待\n骰池：[1]\n\n敘事。\n\n建議動作：${JSON.stringify(["詢問葉晴、林思雨", "離開"])}`;
    const result = parseLastTurnRecord(md);
    expect(result!.suggestedActions).toEqual(["詢問葉晴、林思雨", "離開"]);
  });

  it("敘事正文恰好包含「建議動作：」字樣但非 JSON 編碼時，不誤裁切", () => {
    const md =
      "## [2026-06-19] 回合\n\n玩家行動：等待\n骰池：[1]\n\n系統並未列出\n\n建議動作：你只能憑直覺判斷。";
    const result = parseLastTurnRecord(md);
    expect(result!.narrative).toContain("建議動作：你只能憑直覺判斷。");
    expect(result!.suggestedActions).toEqual([]);
  });
});

describe("readLastTurnRecord", () => {
  it("檔案不存在時回 null", async () => {
    const result = await readLastTurnRecord(path.join(dir, "no-such-file.md"));
    expect(result).toBeNull();
  });

  it("檔案小於檔尾讀取範圍時，整檔內容都在掌握中，可正確還原", async () => {
    const file = path.join(dir, "small.md");
    await writeFile(file, "## [2026-06-19] 回合\n\n玩家行動：等待\n骰池：[1]\n\n小檔案敘事。", "utf8");
    const result = await readLastTurnRecord(file);
    expect(result).toEqual({ narrative: "小檔案敘事。", suggestedActions: [] });
  });

  it("檔案遠大於檔尾讀取範圍時，仍能正確還原最後一段（驗證不必整檔讀取）", async () => {
    const file = path.join(dir, "large.md");
    const padding = "## [2026-01-01] 填充\n\n玩家行動：x\n骰池：[1]\n\n".concat("舊敘事內容。".repeat(20000), "\n\n");
    const lastEntry = "## [2026-06-19] 回合\n\n玩家行動：最新行動\n骰池：[9]\n\n最新的敘事內容。";
    await writeFile(file, padding + lastEntry, "utf8");
    const result = await readLastTurnRecord(file);
    expect(result).toEqual({ narrative: "最新的敘事內容。", suggestedActions: [] });
  });
});
