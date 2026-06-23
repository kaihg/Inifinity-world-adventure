import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { parseLastTurnRecord, type LastTurnRecord } from "./journal.js";
import { parseActiveDungeon } from "./dungeon.js";
import { toTraditional } from "./text/traditionalize.js";

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
  /** 重開頁面時還原畫面用：最後一筆 raw 記錄（journal.md 或進行中副本的 runs/*.md），無記錄時為 null */
  lastTurn: LastTurnRecord | null;
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

/** 條目正規化：去 bullet 前綴 + trim + 繁體化，用於去重比對（簡繁同義視為同一條） */
function normalizeItem(s: string): string {
  return toTraditional(s.trim().replace(/^[-*]\s*/, "").trim());
}

/**
 * 在 `## <含 titleIncludes 的標題>` 區塊末尾（下一個 `## ` 之前）插入新條目；找不到該區塊則原樣返回。
 * 去重（根因 D）：已存在於該區塊的條目（繁體化後相等）不重複附加，本批內部也去重。
 */
function appendToSection(md: string, titleIncludes: string, items: string[]): string {
  if (items.length === 0) return md;
  const lines = md.split("\n");
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+/.test(lines[i])) continue;
    if (start === -1) {
      if (lines[i].includes(titleIncludes)) start = i;
      continue;
    }
    end = i;
    break;
  }
  if (start === -1) return md;

  // 收集該區塊已存在條目的正規化集合，過濾掉重複的新增項（含本批內部重複）
  const existing = new Set<string>();
  for (let i = start + 1; i < end; i++) {
    const t = lines[i].trim();
    if (t.startsWith("-") || t.startsWith("*")) existing.add(normalizeItem(t));
  }
  const fresh: string[] = [];
  for (const it of items) {
    const n = normalizeItem(it);
    if (existing.has(n)) continue;
    existing.add(n);
    fresh.push(it);
  }
  if (fresh.length === 0) return md;

  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, ...fresh.map((it) => `- ${it}`));
  return lines.join("\n");
}

export interface ProtagonistUpdates {
  attributes?: string[];
  skills?: string[];
  items?: string[];
  buffs?: string[];
}

/** 把模型回報的主角成長（屬性/技能/物品/buff 新增項）落地到 protagonist.md 對應區塊 */
export function applyProtagonistUpdates(md: string, updates: ProtagonistUpdates): string {
  let result = md;
  result = appendToSection(result, "屬性", updates.attributes ?? []);
  result = appendToSection(result, "技能", updates.skills ?? []);
  result = appendToSection(result, "物品", updates.items ?? []);
  result = appendToSection(result, "Buff", updates.buffs ?? []);
  return result;
}

/** 防止路徑穿越：NPC id 只允許英數字、連字號、底線、點（不含路徑分隔符） */
export const NPC_ID_RE = /^[\w.-]+$/;

/**
 * 把模型重寫後的完整內容整檔覆寫進 characters/<id>.md（新 NPC 時等同建檔）。
 * id 不合法時靜默略過，不寫出檔案，不中斷呼叫端的其他筆。
 */
export async function rewriteNpcFile(
  worldDir: string,
  id: string,
  content: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  if (!NPC_ID_RE.test(id)) {
    logger.warn({ id }, "touched_entities 含不合法 NPC id，略過");
    return;
  }
  const file = path.join(worldDir, "characters", `${id}.md`);
  await writeFile(file, `${content.trim()}\n`, "utf8");
}

/**
 * 若 characters/index.md 表格尚未有該 id，在「表格最後一列之後」新增一列（新 NPC 首次登場）；
 * 已存在則原樣回傳（避免重複列）。
 * 根因 E：插在最後一個表格資料列之後（而非檔尾），否則會被貼到 `## 鎖定事實` 段落之後、破壞結構。
 * 用「最後一個符合表格列正則的行」當錨點，不依賴空行/`##` 位置；找不到表格才退回檔尾。
 */
export function addCharacterIndexRow(md: string, id: string, name: string): string {
  if (parseCharacterIndex(md).some((npc) => npc.id === id)) return md;
  const row = `| ${id} | ${name} | NPC | 初次登場 | - |`;
  const lines = md.split("\n");
  let lastTableRow = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\|(.+)\|\s*$/.test(lines[i])) lastTableRow = i; // 標題列/分隔線/資料列皆為表格行
  }
  if (lastTableRow === -1) return `${md.trimEnd()}\n${row}\n`;
  lines.splice(lastTableRow + 1, 0, row);
  return lines.join("\n");
}

/**
 * 把 id→近況摘要套用到 characters/index.md 表格的「最近狀態」欄（第 4 欄）。
 * 找不到對應 id 的列、或非表格資料列（標題/分隔線）都原樣保留。
 */
export function applyIndexStatusUpdates(md: string, updates: Record<string, string>): string {
  if (Object.keys(updates).length === 0) return md;
  return md
    .split("\n")
    .map((line) => {
      const m = line.match(/^\|(.+)\|\s*$/);
      if (!m) return line;
      const cells = m[1].split("|").map((c) => c.trim());
      if (cells.length < 4) return line;
      const id = cells[0];
      if (id === "ID" || /^-+$/.test(id) || !(id in updates)) return line;
      cells[3] = updates[id];
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
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

/** 還原畫面用：依 now 的「進行中的副本」欄決定讀 journal.md 或對應 runs/*.md，解析最後一段記錄 */
async function loadLastTurn(worldDir: string, now: NowState, logger: Logger): Promise<LastTurnRecord | null> {
  const active = parseActiveDungeon(now.activeDungeon);
  const rawFile = active
    ? path.join(worldDir, "dungeons", active.dungeonId, "runs", `${active.runId}.md`)
    : path.join(worldDir, "journal.md");
  const md = await readOrEmpty(rawFile, logger);
  return md ? parseLastTurnRecord(md) : null;
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
    lastTurn: await loadLastTurn(worldDir, now, logger),
  };
}
