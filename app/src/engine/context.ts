import { readFile } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";

/** world/now.md 的七個固定欄位（對應回合收束協議的覆寫頁） */
export interface NowState {
  chapter: string;
  scene: string;
  companions: string;
  activeDungeon: string;
  threads: string;
  nextStep: string;
  lastUpdated: string;
}

export interface ProtagonistSummary {
  name: string;
  points: string;
}

export interface ProtagonistDetail extends ProtagonistSummary {
  attributes: string;
  skills: string;
  items: string;
  buffs: string;
}

export interface NpcEntry {
  id: string;
  name: string;
  role: string;
  status: string;
}

export type GameMode = "main-space" | "dungeon";

export interface GameState {
  now: NowState;
  protagonist: ProtagonistSummary;
  protagonistDetail: ProtagonistDetail;
  npcs: NpcEntry[];
  mode: GameMode;
}

/** now.md 欄位標籤 → NowState 鍵。順序即 now.md 的固定欄位順序。 */
const NOW_FIELDS: ReadonlyArray<readonly [string, keyof NowState]> = [
  ["當前篇章", "chapter"],
  ["此刻場景/地點", "scene"],
  ["在場同伴/相關 NPC", "companions"],
  ["進行中的副本", "activeDungeon"],
  ["未解懸念/伏筆", "threads"],
  ["主角下一步打算", "nextStep"],
  ["最後更新", "lastUpdated"],
];

const LABEL_BY_TEXT = new Map(NOW_FIELDS.map(([label, key]) => [label, key]));

/**
 * 解析 now.md。每個欄位的值 = 標籤行冒號後的內容，
 * 加上後續所有「非下一個頂層欄位」的行（巢狀子項、續行）。
 */
export function parseNow(md: string): NowState {
  const now: NowState = {
    chapter: "",
    scene: "",
    companions: "",
    activeDungeon: "",
    threads: "",
    nextStep: "",
    lastUpdated: "",
  };

  let current: keyof NowState | null = null;
  const buffers: Partial<Record<keyof NowState, string[]>> = {};

  for (const rawLine of md.split("\n")) {
    // 頂層欄位行：行首即「- 標籤：」（無前導空白）。縮排子項不算。
    const topField = rawLine.match(/^- ([^：]+?)：(.*)$/);
    if (topField) {
      const key = LABEL_BY_TEXT.get(topField[1].trim());
      if (key) {
        current = key;
        buffers[key] = [];
        const inline = topField[2].trim();
        if (inline) buffers[key]!.push(inline);
      } else {
        // 七欄之外的臨時頂層欄位：結束目前欄位的吸收，不納入任何欄。
        current = null;
      }
      continue;
    }
    // 縮排子項或續行 → 併入目前欄位
    if (current) {
      const text = rawLine.trim().replace(/^[-*]\s*/, "");
      if (text) buffers[current]!.push(text);
    }
  }

  for (const [, key] of NOW_FIELDS) {
    now[key] = (buffers[key] ?? []).join("\n");
  }
  return now;
}

/** 「進行中的副本」非空且非「無」即視為在副本中（resume 路由用） */
export function isInDungeon(now: NowState): boolean {
  const v = now.activeDungeon.split("\n")[0].trim();
  return v !== "" && v !== "無";
}

/** 取出 `## <含 titleIncludes 的標題>` 區塊內容，直到下一個 `## ` 為止 */
function extractSection(md: string, titleIncludes: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inSection = line.includes(titleIncludes);
      continue;
    }
    if (inSection) out.push(line);
  }
  return out.join("\n").trim();
}

/** 解析 protagonist.md 的細節區塊（屬性/技能/物品/buff）供狀態面板用 */
export function parseProtagonistDetail(md: string): ProtagonistDetail {
  return {
    ...parseProtagonist(md),
    attributes: extractSection(md, "屬性"),
    skills: extractSection(md, "技能"),
    items: extractSection(md, "物品"),
    buffs: extractSection(md, "Buff"),
  };
}

/** 解析 characters/index.md 的角色表格，排除 protagonist，供 NPC 面板用 */
export function parseCharacterIndex(md: string): NpcEntry[] {
  const npcs: NpcEntry[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\|(.+)\|\s*$/);
    if (!m) continue;
    const cells = m[1].split("|").map((c) => c.trim());
    if (cells.length < 4) continue;
    const [id, name, role, status] = cells;
    if (id === "ID" || /^-+$/.test(id) || id === "" || id === "protagonist") continue;
    npcs.push({ id, name, role, status });
  }
  return npcs;
}

/** 對 protagonist.md 的「當前積分」套用增減量（結算/回合積分變動用） */
export function applyPointsDelta(md: string, delta: number): string {
  if (!delta) return md;
  return md.replace(
    /^(-\s*當前積分：)\s*(-?\d+)/m,
    (_m, prefix: string, n: string) => `${prefix}${Number(n) + delta}`,
  );
}

/** 從 protagonist.md 擷取輕量摘要（姓名、當前積分） */
export function parseProtagonist(md: string): ProtagonistSummary {
  const name = md.match(/^-\s*姓名：(.*)$/m)?.[1].trim() ?? "";
  const points = md.match(/^-\s*當前積分：(.*)$/m)?.[1].trim() ?? "";
  return { name, points };
}

/** 決定論地讀取 world/ 並組出當前遊戲狀態（resume 入口） */
async function readOrEmpty(file: string, logger: Logger): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn({ err, file }, "讀取狀態檔案失敗（非檔案不存在）");
    }
    return "";
  }
}

export async function loadState(worldDir: string, logger: Logger = defaultLogger): Promise<GameState> {
  const [nowMd, protagonistMd, indexMd] = await Promise.all([
    readFile(path.join(worldDir, "now.md"), "utf8"),
    readFile(path.join(worldDir, "characters", "protagonist.md"), "utf8"),
    readOrEmpty(path.join(worldDir, "characters", "index.md"), logger),
  ]);

  const now = parseNow(nowMd);
  const detail = parseProtagonistDetail(protagonistMd);
  return {
    now,
    protagonist: { name: detail.name, points: detail.points },
    protagonistDetail: detail,
    npcs: parseCharacterIndex(indexMd),
    mode: isInDungeon(now) ? "dungeon" : "main-space",
  };
}
