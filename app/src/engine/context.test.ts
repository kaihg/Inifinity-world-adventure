import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseNow,
  isInDungeon,
  parseProtagonist,
  parseProtagonistDetail,
  parseCharacterIndex,
  applyPointsDelta,
  rewriteNpcFile,
  addCharacterIndexRow,
  applyIndexStatusUpdates,
  loadState,
} from "./context.js";
import { loadConfig } from "../config.js";

const SAMPLE_NOW = `# 當前局勢（Now）

> resume 入口：先讀這份。

- 當前篇章：第一章·初次篩選——準備過夜
- 此刻場景/地點：安全區休息區
- 在場同伴/相關 NPC：
  - **葉晴**（yeqing）：夜間警戒
  - **林思雨**（linsiyu）：同組過夜
- 進行中的副本：無
- 未解懸念/伏筆：
  - 系統倒數無預警調整
  - 潛力指數用途未知
- 主角下一步打算：在休息區過夜
- 最後更新：[2026-06-19] 建立警戒
`;

describe("parseNow", () => {
  it("解析七個固定欄位", () => {
    const now = parseNow(SAMPLE_NOW);
    expect(now.chapter).toContain("第一章");
    expect(now.scene).toBe("安全區休息區");
    expect(now.activeDungeon).toBe("無");
    expect(now.nextStep).toBe("在休息區過夜");
    expect(now.lastUpdated).toContain("2026-06-19");
  });

  it("巢狀子項併入該欄位內容", () => {
    const now = parseNow(SAMPLE_NOW);
    expect(now.companions).toContain("葉晴");
    expect(now.companions).toContain("林思雨");
    expect(now.threads).toContain("潛力指數");
  });
});

describe("parseNow — 容錯", () => {
  // 實際 now.md 會夾帶七欄之外的臨時欄位（積分狀態、已備妥物資…），
  // 這些頂層欄位不可被吸收進前一個欄位，否則 activeDungeon 被汙染、mode 誤判。
  const WITH_EXTRA = `- 進行中的副本：無
- 積分狀態：0（尚未進副本）
- 已備妥物資：剩餘約 3 天份量
- 未解懸念/伏筆：
  - 系統倒數無預警調整
- 主角下一步打算：過夜
- 最後更新：[2026-06-19]
`;

  it("七欄之外的頂層欄位不汙染前一欄位", () => {
    const now = parseNow(WITH_EXTRA);
    expect(now.activeDungeon).toBe("無");
    expect(now.threads).toContain("系統倒數");
    expect(now.threads).not.toContain("積分狀態");
  });

  it("夾帶臨時欄位時 isInDungeon 仍正確判為 false", () => {
    expect(isInDungeon(parseNow(WITH_EXTRA))).toBe(false);
  });
});

describe("isInDungeon", () => {
  it("進行中的副本為『無』時回 false", () => {
    expect(isInDungeon(parseNow(SAMPLE_NOW))).toBe(false);
  });

  it("進行中的副本有 dungeon-id 時回 true", () => {
    const md = SAMPLE_NOW.replace("進行中的副本：無", "進行中的副本：U-001 + run-1");
    expect(isInDungeon(parseNow(md))).toBe(true);
  });
});

describe("parseProtagonist", () => {
  it("擷取姓名與當前積分", () => {
    const md = `# 主角檔案
## 基本資訊
- 姓名：沈奕
## 積分與兌換
- 當前積分：12
`;
    const p = parseProtagonist(md);
    expect(p.name).toBe("沈奕");
    expect(p.points).toBe("12");
  });
});

describe("parseProtagonistDetail", () => {
  const md = `# 主角檔案
## 基本資訊
- 姓名：沈奕
## 積分與兌換
- 當前積分：7
## 屬性
- 力量：中等偏上
- 敏捷：中等
## 技能 / 異能
- （無）
## 物品欄
- 戰術刀
## Buff / Debuff / 狀態
- 輕傷
## 備註
- 新手保護：3 次
`;
  it("擷取各區塊內容", () => {
    const d = parseProtagonistDetail(md);
    expect(d.name).toBe("沈奕");
    expect(d.points).toBe("7");
    expect(d.attributes).toContain("力量：中等偏上");
    expect(d.skills).toContain("（無）");
    expect(d.items).toContain("戰術刀");
    expect(d.buffs).toContain("輕傷");
    // 不可把下一個區塊吃進來
    expect(d.attributes).not.toContain("技能");
  });
});

describe("parseCharacterIndex", () => {
  const md = `# 角色索引
| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |
|----|------|------|----------|--------------|
| protagonist | 沈奕 | 主角 | 安全區 | - |
| yeqing | 葉晴 | NPC / 潛在隊友 | 結盟 | - |
| linsiyu | 林思雨 | NPC | 跟隨 | - |

## 鎖定事實
`;
  it("解析表格、排除 protagonist", () => {
    const npcs = parseCharacterIndex(md);
    expect(npcs).toHaveLength(2);
    expect(npcs[0]).toEqual({ id: "yeqing", name: "葉晴", role: "NPC / 潛在隊友", status: "結盟" });
    expect(npcs.map((n) => n.id)).not.toContain("protagonist");
  });
});

describe("applyPointsDelta", () => {
  it("正負 delta 都正確累加", () => {
    expect(applyPointsDelta("- 當前積分：5\n", 3)).toContain("- 當前積分：8");
    expect(applyPointsDelta("- 當前積分：10\n", -4)).toContain("- 當前積分：6");
  });
  it("delta 為 0 時原樣返回", () => {
    expect(applyPointsDelta("- 當前積分：5\n", 0)).toBe("- 當前積分：5\n");
  });
});


describe("applyIndexStatusUpdates", () => {
  const indexMd = `# 角色索引

| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |
|----|------|------|----------|--------------|
| protagonist | 沈奕 | 主角 | 安全區 | - |
| yeqing | 葉晴 | NPC / 潛在隊友 | 結盟 | - |
| linsiyu | 林思雨 | NPC | 跟隨 | - |

## 鎖定事實
`;

  it("更新對應 id 列的最近狀態欄，其他列與其他欄不變", () => {
    const result = applyIndexStatusUpdates(indexMd, { yeqing: "信任提升，主動分享情報" });
    expect(result).toContain("| yeqing | 葉晴 | NPC / 潛在隊友 | 信任提升，主動分享情報 | - |");
    expect(result).toContain("| linsiyu | 林思雨 | NPC | 跟隨 | - |"); // 未更新的列原樣保留
    expect(result).toContain("| protagonist | 沈奕 | 主角 | 安全區 | - |");
  });

  it("找不到對應 id 時原樣返回", () => {
    expect(applyIndexStatusUpdates(indexMd, { "no-such-id": "x" })).toBe(indexMd);
  });

  it("更新為空物件時原樣返回", () => {
    expect(applyIndexStatusUpdates(indexMd, {})).toBe(indexMd);
  });

  it("不會誤改標題列或分隔線", () => {
    const result = applyIndexStatusUpdates(indexMd, { ID: "x", "----": "x" });
    expect(result).toBe(indexMd);
  });

  it("多筆同時更新都生效", () => {
    const result = applyIndexStatusUpdates(indexMd, { yeqing: "更新一", linsiyu: "更新二" });
    expect(result).toContain("| yeqing | 葉晴 | NPC / 潛在隊友 | 更新一 | - |");
    expect(result).toContain("| linsiyu | 林思雨 | NPC | 更新二 | - |");
  });
});

describe("rewriteNpcFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "iwa-npc-rewrite-"));
    await mkdir(path.join(dir, "characters"), { recursive: true });
    await writeFile(path.join(dir, "characters", "yeqing.md"), "# 葉晴\n前特種部隊教官\n", "utf8");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("整檔覆寫既有角色檔，不殘留舊內容", async () => {
    await rewriteNpcFile(dir, "yeqing", "# 葉晴\n\n前特種部隊教官，對沈奕的信任已經提升。");
    const md = await readFile(path.join(dir, "characters", "yeqing.md"), "utf8");
    expect(md).toContain("信任已經提升");
    expect(md).not.toContain("前特種部隊教官\n"); // 舊版單獨一行的描述已被新版整段取代
  });

  it("角色檔不存在時直接建立（新 NPC）", async () => {
    await rewriteNpcFile(dir, "newcomer", "# 新來的人\n\n剛剛登場。");
    const md = await readFile(path.join(dir, "characters", "newcomer.md"), "utf8");
    expect(md).toContain("剛剛登場");
  });

  it("id 含路徑分隔符等不合法字元時靜默略過，不寫出檔案", async () => {
    await rewriteNpcFile(dir, "../escape", "嘗試逃出 characters/");
    const escaped = await readFile(path.join(dir, "escape.md"), "utf8").catch(() => null);
    expect(escaped).toBeNull();
  });
});

describe("addCharacterIndexRow", () => {
  const INDEX = [
    "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
    "|----|------|------|----------|--------------|",
    "| yeqing | 葉晴 | NPC | 結盟 | - |",
  ].join("\n");

  it("id 已存在時原樣回傳，不重複加列", () => {
    expect(addCharacterIndexRow(INDEX, "yeqing", "葉晴")).toBe(INDEX);
  });

  it("id 不存在時在表尾加一列", () => {
    const result = addCharacterIndexRow(INDEX, "newcomer", "新來的人");
    expect(result).toContain("| yeqing | 葉晴 | NPC | 結盟 | - |");
    expect(result).toContain("| newcomer | 新來的人 | NPC | 初次登場 | - |");
  });

  it("新列插在表格最後一列之後、## 鎖定事實段落之前（根因 E）", () => {
    const withLocked = [
      "# 角色索引",
      "",
      "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
      "|----|------|------|----------|--------------|",
      "| yeqing | 葉晴 | NPC | 結盟 | - |",
      "",
      "## 鎖定事實",
      "",
      "### yeqing — 葉晴",
      "- 前特種部隊教官",
    ].join("\n");
    const result = addCharacterIndexRow(withLocked, "chenzhe", "陳哲");
    const lines = result.split("\n");
    const newRowIdx = lines.findIndex((l) => l.includes("| chenzhe |"));
    const lockedIdx = lines.findIndex((l) => l.startsWith("## 鎖定事實"));
    const yeqingRowIdx = lines.findIndex((l) => l.includes("| yeqing |"));
    // 新列在 yeqing 列之後、且在 ## 鎖定事實 之前（不是貼到檔尾）
    expect(newRowIdx).toBeGreaterThan(yeqingRowIdx);
    expect(newRowIdx).toBeLessThan(lockedIdx);
    // 鎖定事實段落未被破壞
    expect(result).toContain("### yeqing — 葉晴");
    expect(result).toContain("- 前特種部隊教官");
  });
});

describe("loadState（讀實際 world/）", () => {
  it("回傳 now/protagonist/mode，欄位非空", async () => {
    const worldDir = loadConfig({}).worldDir;
    const state = await loadState(worldDir);
    expect(state.now.chapter).not.toBe("");
    expect(state.protagonist.name).toBe("沈奕");
    expect(["main-space", "dungeon"]).toContain(state.mode);
    expect(state.lastTurn).not.toBeNull();
    expect(state.lastTurn!.narrative.length).toBeGreaterThan(0);
  });
});

describe("loadState — lastTurn 還原（fixture worldDir）", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "iwa-context-lastturn-"));
    await mkdir(path.join(dir, "characters"), { recursive: true });
    await writeFile(path.join(dir, "characters", "protagonist.md"), "- 姓名：測試\n- 當前積分：0\n", "utf8");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const nowMd = (activeDungeon: string) =>
    [
      "- 當前篇章：測試",
      "- 此刻場景/地點：測試",
      "- 在場同伴/相關 NPC：無",
      `- 進行中的副本：${activeDungeon}`,
      "- 未解懸念/伏筆：無",
      "- 主角下一步打算：無",
      "- 最後更新：[2026-06-19] 測試",
      "",
    ].join("\n");

  it("主空間：從 journal.md 還原最後一段敘事", async () => {
    await writeFile(path.join(dir, "now.md"), nowMd("無"), "utf8");
    await writeFile(
      path.join(dir, "journal.md"),
      "## [2026-06-19] 回合\n\n玩家行動：等待\n骰池：[1]\n\n主空間敘事內容。\n",
      "utf8",
    );
    const state = await loadState(dir);
    expect(state.lastTurn).toEqual({ narrative: "主空間敘事內容。", suggestedActions: [] });
  });

  it("副本中：從對應 runs/<run-id>.md 還原，而非 journal.md", async () => {
    await writeFile(path.join(dir, "now.md"), nowMd("U-001 + run-1"), "utf8");
    await writeFile(path.join(dir, "journal.md"), "## [2026-06-18] 舊\n\n玩家行動：x\n骰池：[1]\n\n主空間舊敘事。\n", "utf8");
    await mkdir(path.join(dir, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(
      path.join(dir, "dungeons", "U-001", "runs", "run-1.md"),
      "## [2026-06-19] 回合\n\n玩家行動：戰鬥\n骰池：[1]\n\n副本敘事內容。\n\n建議動作：撤退、繼續",
      "utf8",
    );
    const state = await loadState(dir);
    expect(state.lastTurn).toEqual({ narrative: "副本敘事內容。", suggestedActions: ["撤退", "繼續"] });
  });

  it("raw 檔不存在時 lastTurn 為 null（不報錯）", async () => {
    await writeFile(path.join(dir, "now.md"), nowMd("無"), "utf8");
    const state = await loadState(dir);
    expect(state.lastTurn).toBeNull();
  });
});
