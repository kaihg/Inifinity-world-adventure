import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { runMainSpaceTurn, runDungeonTurn, type TurnEvent, type TurnDeps, type PendingLoreSync } from "./index.js";
import type { RecallHit, RecallIndex } from "../../recall/store.js";
import * as contextMod from "../context.js";
import type { Embedder } from "../../recall/embedder.js";

function fakeEmbedder(vectorsByText: Record<string, number[]>): Embedder {
  return {
    async embed(texts: string[]) {
      return texts.map((t) => vectorsByText[t] ?? [0, 0]);
    },
  };
}

/** 測試用假 RecallIndex：query 回傳固定結果，upsertFile/removeFile 記錄呼叫供斷言 */
function fakeRecall(hits: RecallHit[] = []): RecallIndex & { upserted: Array<{ relPath: string; content: string }> } {
  const upserted: Array<{ relPath: string; content: string }> = [];
  return {
    upserted,
    async query() {
      return hits;
    },
    async upsertFile(relPath: string, content: string) {
      upserted.push({ relPath, content });
    },
    async removeFile() {},
  };
}

function fakeClient(chunks: string[]): LlmClient {
  return {
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
      for (const c of chunks) yield c;
    },
  };
}

/** 每次 streamChat 回傳序列中的下一個完整回應 */
function sequencedClient(responses: string[]): LlmClient {
  let i = 0;
  return {
    async *streamChat(_m: ChatMessage[]): AsyncIterable<string> {
      yield responses[Math.min(i, responses.length - 1)];
      i++;
    },
  };
}

function controlJson(awaiting: boolean, summary: string): string {
  return JSON.stringify({
    state_changes: {},
    rolls: [],
    mode_transition: null,
    awaiting_user_input: awaiting,
    suggested_actions: [],
    commit_summary: summary,
  });
}

/**
 * twoBrainClient 是 sequencedClient 的語意別名：
 * - sequencedClient：表達「呼叫順序」語義，適合需要序列回應的通用測試
 * - twoBrainClient：表達「主腦散文與副大腦 JSON 交替供應」語義，讓測試意圖更易讀
 * 兩者行為完全相同；若未來需要真正的串流分岔可將 twoBrainClient 替換為獨立實作。
 */
const twoBrainClient = sequencedClient;

let world: string;
beforeEach(async () => {
  world = await mkdtemp(path.join(tmpdir(), "iwa-turn-"));
  await mkdir(path.join(world, "characters"), { recursive: true });
  await writeFile(path.join(world, "setting.md"), "# 設定\n禁止竄改數值。\n");
  await writeFile(
    path.join(world, "now.md"),
    "- 當前篇章：第一章\n- 此刻場景/地點：安全區\n- 進行中的副本：無\n- 最後更新：[2026-06-18] 舊\n",
  );
  await writeFile(
    path.join(world, "characters", "protagonist.md"),
    "# 主角\n- 姓名：沈奕\n- 當前積分：0\n",
  );
});
afterEach(async () => {
  await rm(world, { recursive: true, force: true });
});

async function makeTempWorld(opts: { withYeqing?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "world-turn-"));
  const charsDir = path.join(dir, "characters");
  await mkdir(charsDir, { recursive: true });
  await writeFile(path.join(dir, "now.md"), [
    "- 當前篇章：第一章",
    "- 此刻場景/地點：安全區大廳",
    "- 在場同伴/相關 NPC：葉晴",
    "- 進行中的副本：無",
    "- 未解懸念/伏筆：無",
    "- 主角下一步打算：等待",
    "- 最後更新：2026-06-19",
  ].join("\n"), "utf8");
  await writeFile(path.join(charsDir, "protagonist.md"), [
    "- 姓名：沈奕",
    "- 當前積分：100",
  ].join("\n"), "utf8");
  await writeFile(path.join(charsDir, "index.md"), [
    "| ID | 姓名 | 定位 | 最近狀態 |",
    "|----|------|------|----------|",
    "| yeqing | 葉晴 | NPC | 在場 |",
  ].join("\n"), "utf8");
  if (opts.withYeqing) {
    await writeFile(path.join(charsDir, "yeqing.md"), "# 葉晴\n前特種部隊教官", "utf8");
  }
  return dir;
}

describe("runMainSpaceTurn — 結構化輸出", () => {
  it("串流敘事、副大腦套用 now，Layer 3 落地積分、commit，done 帶 awaitingUserInput/suggestedActions", async () => {
    const commits: string[] = [];
    const narrative = "沈奕走進資訊室。";
    const ctrl = JSON.stringify({
      state_changes: { now: { scene: "資訊室", nextStep: "找葉晴" } },
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: ["找葉晴", "離開"],
      commit_summary: "沈奕進資訊室",
    });
    const ls = JSON.stringify({
      state_changes: { protagonist_points_delta: 2, protagonist_changed: true },
    });
    // 依 system prompt 路由：Layer 3 lore-sync → ls；主角重寫 → 含積分2的全文；其餘 → ctrl
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("reactive-lore-sync")) { yield ls; return; }
        if (system.includes("主角檔案維護者")) {
          yield "# 主角\n- 姓名：沈奕\n- 當前積分：2\n";
          return;
        }
        yield ctrl;
      },
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient([narrative]),
        controlClient: client,
        worldDir: world,
        commit: async (m) => { commits.push(m); return true; },
        today: () => "2026-06-19",
        dicePool: [10, 20],
      },
      "去資訊室",
    )) {
      events.push(ev);
    }

    const streamed = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
    expect(streamed).toContain("沈奕走進資訊室。");
    expect(streamed).not.toContain("===STATE===");

    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.awaitingUserInput).toBe(true);
    expect(done.suggestedActions).toEqual(["找葉晴", "離開"]);

    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("- 此刻場景/地點：資訊室");
    expect(now).toContain("- 主角下一步打算：找葉晴");
    expect(now).toContain("- 最後更新：[2026-06-19] 沈奕進資訊室");

    const prot = await readFile(path.join(world, "characters", "protagonist.md"), "utf8");
    expect(prot).toContain("- 當前積分：2");

    const journal = await readFile(path.join(world, "journal.md"), "utf8");
    expect(journal).toContain("## [2026-06-19] 沈奕進資訊室");
    expect(journal).toContain("去資訊室");

    expect(commits[0]).toBe("沈奕進資訊室");
  });

  it("done 帶本回合 Layer 2 落地後的 state 快照（now 欄已更新）", async () => {
    const narrative = "沈奕走進資訊室。";
    const ctrl = JSON.stringify({
      state_changes: { now: { scene: "資訊室", nextStep: "找葉晴" } },
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: ["找葉晴"],
      commit_summary: "沈奕進資訊室",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient([narrative]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [10, 20],
      },
      "去資訊室",
    )) {
      events.push(ev);
    }

    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.state).toBeDefined();
    // now 欄由 Layer 2 落地，done.state 快照已包含這些更新
    expect(done.state.now.scene).toBe("資訊室");
    expect(done.state.now.nextStep).toBe("找葉晴");
    // 注意：積分由 Layer 3 落地，done.state 快照（Layer 2 完成時）不含 Layer 3 的成長
  });

  it("副大腦試圖用 now.activeDungeon 自行覆寫副本欄時，引擎忽略該欄（由 mode_transition 管理）", async () => {
    const ctrl = JSON.stringify({
      state_changes: { now: { scene: "詭異的走廊", activeDungeon: "U-999 + run-1" } },
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: [],
      commit_summary: "場景變化",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["四周突然變得詭異。"]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "往前走",
    )) {
      events.push(ev);
    }
    const now = await readFile(path.join(world, "now.md"), "utf8");
    // scene 等正常欄位仍套用
    expect(now).toContain("- 此刻場景/地點：詭異的走廊");
    // 但 activeDungeon 被引擎忽略，維持「無」，不會繞過 enterDungeon 流程
    expect(now).toContain("- 進行中的副本：無");
    expect(now).not.toContain("U-999");
  });

  it("主角成長改由 Layer 3 落地（積分 + 技能/物品整合進 protagonist.md）", async () => {
    await writeFile(
      path.join(world, "characters", "protagonist.md"),
      ["# 主角", "- 姓名：沈奕", "- 當前積分：0", "", "## 技能 / 異能", "- （無）", "", "## 物品欄", "- 戰術刀", ""].join("\n"),
      "utf8",
    );
    await writeFile(path.join(world, "characters", "index.md"), "| ID | 姓名 |\n|----|------|\n", "utf8");
    // Layer 2 只出顯示欄位；Layer 3 出 protagonist 變化
    const fc = JSON.stringify({
      state_changes: { now: { scene: "訓練場" } },
      rolls: [], mode_transition: null, awaiting_user_input: true,
      suggested_actions: [], commit_summary: "沈奕成長",
    });
    const ls = JSON.stringify({
      state_changes: { protagonist_points_delta: 1, protagonist_changed: true },
    });
    // fakeClient 依 system prompt 內容回不同層；主角重寫回整檔新版
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("Layer 3：reactive-lore-sync") || system.includes("reactive-lore-sync")) { yield ls; return; }
        if (system.includes("主角檔案維護者")) {
          yield "# 主角\n- 姓名：沈奕\n- 當前積分：1\n\n## 技能 / 異能\n- 近戰格鬥精通\n\n## 物品欄\n- 戰術刀\n- 生鏽鐵管\n";
          return;
        }
        if (system.includes("fast-control")) { yield fc; return; }
        yield "沈奕領悟近戰格鬥精通，撿起鐵管。"; // 主腦敘事
      },
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      { client, worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [1] },
      "練習格鬥",
    )) {
      events.push(ev);
    }
    const prot = await readFile(path.join(world, "characters", "protagonist.md"), "utf8");
    expect(prot).toContain("- 當前積分：1");
    expect(prot).toContain("近戰格鬥精通");
    expect(prot).toContain("生鏽鐵管");
  });

  it("touched_entities（npc）：整檔重寫角色檔，並用小模型摘要同步進 characters/index.md", async () => {
    await writeFile(path.join(world, "characters", "yeqing.md"), "# 葉晴\n- 姓名：葉晴\n前特種部隊教官\n", "utf8");
    await writeFile(
      path.join(world, "characters", "index.md"),
      [
        "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
        "|----|------|------|----------|--------------|",
        "| yeqing | 葉晴 | NPC | 結盟 | - |",
      ].join("\n"),
      "utf8",
    );
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "yeqing", category: "npc", name: "葉晴", excerpt: "葉晴點點頭，眼神多了幾分信任。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "葉晴信任提升",
    });
    const events: TurnEvent[] = [];
    // 序列：主腦敘事 → Layer 2 fast-control(ctrl) → Layer 3 抽取(ctrl) → 比較重寫(新版角色檔全文)
    for await (const ev of runMainSpaceTurn(
      {
        client: sequencedClient([
          "葉晴點點頭，眼神多了幾分信任。",
          ctrl,
          ctrl,
          "# 葉晴\n- 姓名：葉晴\n前特種部隊教官，對沈奕的信任進一步提升。",
        ]),
        characterClient: fakeClient(["信任大幅提升"]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "和葉晴交談",
    )) {
      events.push(ev);
    }
    const yeqing = await readFile(path.join(world, "characters", "yeqing.md"), "utf8");
    expect(yeqing).toContain("對沈奕的信任進一步提升");
    const index = await readFile(path.join(world, "characters", "index.md"), "utf8");
    expect(index).toContain("| yeqing | 葉晴 | NPC | 信任大幅提升 | - |");
  });

  it("touched_entities（npc，全新角色）：建檔並掛進 characters/index.md", async () => {
    await writeFile(
      path.join(world, "characters", "index.md"),
      ["| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |", "|----|------|------|----------|--------------|"].join("\n"),
      "utf8",
    );
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "newcomer", category: "npc", name: "陌生男子", excerpt: "一名陌生男子從陰影中走出，自稱姓陳。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "新角色登場",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: sequencedClient([
          "一名陌生男子從陰影中走出，自稱姓陳。",
          ctrl,
          ctrl,
          "# 陳先生\n\n自稱姓陳的陌生男子，來歷不明。",
        ]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "觀察陌生男子",
    )) {
      events.push(ev);
    }
    const newcomer = await readFile(path.join(world, "characters", "newcomer.md"), "utf8");
    expect(newcomer).toContain("來歷不明");
    const index = await readFile(path.join(world, "characters", "index.md"), "utf8");
    expect(index).toContain("| newcomer | 陳先生 | NPC | 初次登場 | - |");
  });

  it("touched_entities（兩個 npc）：第一筆重寫回空字串被略過，第二筆仍正常寫檔並 commit", async () => {
    await writeFile(
      path.join(world, "characters", "index.md"),
      [
        "| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |",
        "|----|------|------|----------|--------------|",
      ].join("\n"),
      "utf8",
    );
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "npc-a", category: "npc", name: "甲", excerpt: "甲只是路過，沒說什麼。" },
          { id: "npc-b", category: "npc", name: "乙", excerpt: "乙自稱是這裡的嚮導。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "兩名 NPC 登場",
    });
    let committed = false;
    const events: TurnEvent[] = [];
    // 兩個 NPC 的整檔重寫透過 Promise.all 併發跑，呼叫順序不保證；
    // 故依「內容」而非「呼叫序」決定回應：甲→空字串（視為失敗略過）、乙→正常內容。
    const client: LlmClient = {
      async *streamChat(messages: ChatMessage[]) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        // Layer 2 fast-control 與 Layer 3 抽取：回 ctrl JSON
        if (system.includes("fast-control") || system.includes("Layer 3：reactive-lore-sync")) {
          yield ctrl;
          return;
        }
        // 知識庫維護者（整檔重寫）：依文件標題/片段判斷是甲還是乙
        if (system.includes("知識庫維護者")) {
          yield user.includes("甲") ? "" : "# 乙\n\n自稱是這裡的嚮導，來歷不明。";
          return;
        }
        // 主腦敘事
        yield "甲只是路過，沒說什麼。乙自稱是這裡的嚮導。";
      },
    };
    for await (const ev of runMainSpaceTurn(
      {
        client,
        worldDir: world,
        commit: async () => {
          committed = true;
          return true;
        },
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "觀察兩人",
    )) {
      events.push(ev);
    }
    await expect(readFile(path.join(world, "characters", "npc-a.md"), "utf8")).rejects.toThrow();
    const npcB = await readFile(path.join(world, "characters", "npc-b.md"), "utf8");
    expect(npcB).toContain("來歷不明");
    expect(committed).toBe(true);
  });

  it("touched_entities（item，全新）：首次生成 secrets.md，並把比較重寫的內容整檔寫進 wiki.md", async () => {
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "沈奕從地上撿起一根生鏽鐵管，管身刻有奇怪符號。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "撿到鐵管",
    });
    const events: TurnEvent[] = [];
    // 序列：主腦敘事 → Layer 2(ctrl) → Layer 3 抽取(ctrl) → 道具 secrets 生成（generateItemSecrets 用 deps.client）→ 比較重寫
    for await (const ev of runMainSpaceTurn(
      {
        client: sequencedClient([
          "沈奕從地上撿起一根生鏽鐵管，管身刻有奇怪符號。",
          ctrl,
          ctrl,
          "其實是某把武器的殘骸，蘊含未知力量。",
          "# 道具（rusty-pipe）\n\n管身刻有奇怪符號，來歷不明。",
        ]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "撿起鐵管",
    )) {
      events.push(ev);
    }
    const secrets = await readFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "utf8");
    expect(secrets).toContain("某把武器的殘骸");
    const wiki = await readFile(path.join(world, "items", "rusty-pipe", "wiki.md"), "utf8");
    expect(wiki).toContain("管身刻有奇怪符號，來歷不明");
  });

  it("touched_entities（item，已有 secrets）：不重複生成 secrets，只整檔重寫 wiki", async () => {
    await mkdir(path.join(world, "items", "rusty-pipe"), { recursive: true });
    await writeFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "# 道具隱藏設定（生鏽鐵管）\n\n原始真相\n");
    const ctrl = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "沈奕又看了一眼鐵管，發現符號似乎在發光。" },
        ],
      },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "再次檢視鐵管",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: sequencedClient([
          "沈奕又看了一眼鐵管，發現符號似乎在發光。",
          ctrl,
          ctrl,
          "# 道具（rusty-pipe）\n\n管身符號會微微發光。",
        ]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "再看看鐵管",
    )) {
      events.push(ev);
    }
    const secrets = await readFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "utf8");
    expect(secrets).toContain("原始真相");
    const wiki = await readFile(path.join(world, "items", "rusty-pipe", "wiki.md"), "utf8");
    expect(wiki).toContain("管身符號會微微發光");
  });

  it("副大腦輸出無法解析時降級：保留敘事、發 warning、暫停、仍 commit", async () => {
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["這是一段正常敘事。"]),
        controlClient: fakeClient(["副大腦壞掉了，沒有 JSON"]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "做點事",
    )) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === "warning")).toBe(true);
    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.awaitingUserInput).toBe(true); // 降級保守暫停
    const streamed = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
    expect(streamed).toContain("這是一段正常敘事。");
    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("- 最後更新：[2026-06-19]");
  });

  it("副大腦呼叫整個拋錯時也降級（不中斷回合）", async () => {
    const throwingControl: LlmClient = {
      async *streamChat() { throw new Error("control LLM 掛了"); yield ""; },
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["敘事正常。"]),
        controlClient: throwingControl,
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "做點事",
    )) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === "warning")).toBe(true);
    const done: any = events.at(-1);
    expect(done.awaitingUserInput).toBe(true);
  });

  it("副大腦前幾次輸出壞掉，重試後成功：不發 warning、正確採用重試後的結構化結果", async () => {
    let callCount = 0;
    const controlClient: LlmClient = {
      async *streamChat() {
        callCount++;
        if (callCount < 3) {
          yield "前兩次都是壞掉的輸出，沒有 JSON";
        } else {
          yield JSON.stringify({
            state_changes: { now: { scene: "資訊室" } },
            rolls: [], mode_transition: null,
            awaiting_user_input: false, suggested_actions: ["繼續前進"],
            commit_summary: "重試後終於解析成功",
          });
        }
      },
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["敘事正常。"]),
        controlClient,
        loreClient: fakeClient([JSON.stringify({ state_changes: {} })]), // 與 Layer 2 分開，避免混入呼叫次數
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "做點事",
    )) {
      events.push(ev);
    }
    expect(callCount).toBe(3); // 前兩次失敗 + 第三次成功，未超過預設重試上限
    expect(events.some((e) => e.type === "warning")).toBe(false);
    const done: any = events.at(-1);
    expect(done.awaitingUserInput).toBe(false);
    expect(done.suggestedActions).toEqual(["繼續前進"]);
  });

  it("副大腦一直壞掉，重試次數可由 controlMaxRetries 設定上限，耗盡後才降級", async () => {
    let callCount = 0;
    const controlClient: LlmClient = {
      async *streamChat() {
        callCount++;
        yield "永遠都是壞掉的輸出";
      },
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["敘事正常。"]),
        controlClient,
        loreClient: fakeClient([JSON.stringify({ state_changes: {} })]), // 與 Layer 2 分開，避免混入呼叫次數
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
        controlMaxRetries: 1, // 最多重試 1 次，共 2 次嘗試
      },
      "做點事",
    )) {
      events.push(ev);
    }
    expect(callCount).toBe(2); // 1 次原始呼叫 + 1 次重試，耗盡後降級
    expect(events.some((e) => e.type === "warning")).toBe(true);
    const done: any = events.at(-1);
    expect(done.awaitingUserInput).toBe(true);
  });
});

describe("runDungeonTurn", () => {
  it("落地到 log.md、整檔重寫副本 wiki.md（dungeon_wiki_excerpt）", async () => {
    await mkdir(path.join(world, "dungeons", "U-001"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "log.md"), "# 副本 U-001 · Log\n\n## run-1（2026-06-19）\n\n- 進入時角色狀態：x\n- 本次目標：g\n\n---\n\n");
    await writeFile(path.join(world, "dungeons", "U-001", "secrets.md"), "真相：地板會塌\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    const narrative = "你踏入大廳，三道門並排。";
    const ctrl = JSON.stringify({
      state_changes: { dungeon_wiki_excerpt: "入口大廳有三道門" },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "進入大廳",
    });

    const events: TurnEvent[] = [];
    // 序列：主腦敘事(client) → Layer 2(controlClient) → Layer 3 抽取(controlClient，loreClient 缺省退回) → 比較重寫(controlClient)
    for await (const ev of runDungeonTurn(
      {
        client: fakeClient([narrative]),
        controlClient: sequencedClient([ctrl, ctrl, "# 副本 U-001 · 已揭露知識（Wiki）\n\n入口大廳有三道門。"]),
        worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [5],
      },
      "往前走",
    )) {
      events.push(ev);
    }

    const run = await readFile(path.join(world, "dungeons", "U-001", "log.md"), "utf8");
    expect(run).toContain("## [2026-06-19] 進入大廳");
    expect(run).toContain("往前走");
    const wiki = await readFile(path.join(world, "dungeons", "U-001", "wiki.md"), "utf8");
    expect(wiki).toContain("入口大廳有三道門");
    // journal 不該被副本回合寫入
    const journalExists = await readFile(path.join(world, "journal.md"), "utf8").then(() => true).catch(() => false);
    expect(journalExists).toBe(false);
  });
});

describe("pre-pass 整合測試", () => {
  it("characterClient 注入後意圖出現在 system prompt（主空間）", async () => {
    const charClient: LlmClient = {
      async *streamChat() {
        yield JSON.stringify({ stance: "觀察", intent: "提暗號", tone: "冷靜" });
      },
    };
    const controlClient: LlmClient = {
      async *streamChat() {
        yield JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        });
      },
    };
    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        capturedSystem = msgs[0].content;
        yield "純敘事內容";
      },
    };

    const worldDir = await makeTempWorld({ withYeqing: true });
    try {
      const deps: TurnDeps = {
        client: mainClient,
        characterClient: charClient,
        controlClient,
        worldDir,
        commit: async () => false,
        today: () => "2026-06-19",
        dicePool: [50],
      };
      const events = [];
      for await (const ev of runMainSpaceTurn(deps, "測試")) events.push(ev);

      expect(capturedSystem).toContain("## 在場角色本回合意圖");
    } finally {
      await rm(worldDir, { recursive: true, force: true });
    }
  });

  it("characterClient 失敗時回合仍正常完成（降級）", async () => {
    const charClient: LlmClient = {
      async *streamChat() {
        throw new Error("LLM 掛了");
        yield "";
      },
    };
    const mainClient: LlmClient = {
      async *streamChat() { yield "敘事"; },
    };
    const controlClient: LlmClient = {
      async *streamChat() {
        yield JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        });
      },
    };
    const worldDir = await makeTempWorld({ withYeqing: true });
    try {
      const deps: TurnDeps = {
        client: mainClient,
        characterClient: charClient,
        controlClient,
        worldDir,
        commit: async () => false,
        today: () => "2026-06-19",
        dicePool: [50],
      };
      const events = [];
      for await (const ev of runMainSpaceTurn(deps, "測試")) events.push(ev);
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
    } finally {
      await rm(worldDir, { recursive: true, force: true });
    }
  });
});

describe("recall 整合測試", () => {
  it("deps.recall 注入後檢索結果出現在 system prompt（主空間）", async () => {
    // 雙腦架構下主腦先被呼叫、副大腦（缺 controlClient 時退回同一 client）後被呼叫；
    // recallBlock 只注入主腦 prompt，故只擷取第一次（主腦）呼叫的 system。
    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        if (!capturedSystem) capturedSystem = msgs[0].content;
        yield "純敘事內容";
      },
    };
    const controlClient = fakeClient([
      JSON.stringify({
        state_changes: {},
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "test",
      }),
    ]);
    const recall = fakeRecall([{ file: "characters/yeqing.md", heading: "近況", text: "葉晴受傷了", score: 0.9 }]);

    const deps: TurnDeps = {
      client: mainClient,
      controlClient,
      worldDir: world,
      commit: async () => false,
      today: () => "2026-06-19",
      dicePool: [50],
      recall,
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "測試")) events.push(ev);

    expect(capturedSystem).toContain("葉晴受傷了");
  });

  it("回合結束後重新索引 journal 與主角檔（main-space）", async () => {
    const recall = fakeRecall();
    const response =
      "沈奕成長了。\n===STATE===\n" +
      JSON.stringify({
        state_changes: { protagonist_points_delta: 5 },
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "成長",
      });

    const deps: TurnDeps = {
      client: fakeClient([response]),
      worldDir: world,
      commit: async () => true,
      today: () => "2026-06-19",
      dicePool: [1],
      recall,
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "行動")) events.push(ev);

    const relPaths = recall.upserted.map((u) => u.relPath);
    expect(relPaths).toContain("journal.md");
    expect(relPaths).toContain(path.join("characters", "protagonist.md"));
  });

  it("deps.recall.query 失敗時回合仍正常完成（降級，無 recall 區塊）", async () => {
    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        capturedSystem = msgs[0].content;
        yield `敘事\n===STATE===\n${JSON.stringify({
          state_changes: {},
          rolls: [],
          mode_transition: null,
          awaiting_user_input: true,
          suggested_actions: [],
          commit_summary: "test",
        })}`;
      },
    };
    const recall: RecallIndex = {
      async query() {
        throw new Error("索引掛了");
      },
      async upsertFile() {},
      async removeFile() {},
    };

    const deps: TurnDeps = {
      client: mainClient,
      worldDir: world,
      commit: async () => false,
      today: () => "2026-06-19",
      dicePool: [50],
      recall,
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "測試")) events.push(ev);

    const done = events.find((e) => e.type === "done");
    const warning = events.find((e) => e.type === "warning");
    expect(done).toBeDefined();
    expect(warning).toBeDefined();
    expect(capturedSystem).not.toContain("檢索到的相關記錄");
  });

  it("副本回合結束後重新索引 run log 與 wiki（有 dungeon_wiki_excerpt 時）", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(path.join(world, "dungeons", "U-001", "secrets.md"), "真相：地板會塌\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    const ctrlJson = JSON.stringify({
      state_changes: { dungeon_wiki_excerpt: "入口大廳有三道門" },
      rolls: [], mode_transition: null, awaiting_user_input: true, suggested_actions: [],
      commit_summary: "進入大廳",
    });
    const response = "你踏入大廳，三道門並排。\n===STATE===\n" + ctrlJson;

    const recall = fakeRecall();
    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(
      {
        client: fakeClient([response]),
        loreClient: sequencedClient([ctrlJson, "# 副本 U-001 · 已揭露知識（Wiki）\n\n入口大廳有三道門。"]),
        worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [5], recall,
      },
      "往前走",
    )) {
      events.push(ev);
    }

    const relPaths = recall.upserted.map((u) => u.relPath);
    expect(relPaths).toContain(path.join("dungeons", "U-001", "log.md"));
    expect(relPaths).toContain(path.join("dungeons", "U-001", "wiki.md"));
  });
});

/** 建立一個可手動控制何時 resolve 的 promise，供「卡住的 fake loreClient」測試使用 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Layer 3 reactive-lore-sync 接力（pendingLoreSync）", () => {
  it("提供 pendingLoreSync 時，done event 在 Layer 3 resolve 前就已送出（不卡主流程）", async () => {
    const gate = createDeferred<void>();
    const loreClient: LlmClient = {
      async *streamChat() {
        await gate.promise;
        yield "{}";
      },
    };
    const pendingLoreSync = { promise: null as Promise<void> | null };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["敘事內容。"]),
        controlClient: fakeClient([controlJson(true, "x")]),
        loreClient,
        pendingLoreSync,
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "做點事",
    )) {
      events.push(ev);
    }
    // 沒有等待 gate.resolve()，迴圈卻已經跑完，證明 done 不會被卡住的 loreClient 卡住
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(pendingLoreSync.promise).not.toBeNull();
    gate.resolve();
    await pendingLoreSync.promise; // 收尾，避免懸而未決的 promise 影響其他測試
  });

  it("共用同一個 pendingLoreSync 連續呼叫兩次：第二次呼叫前已等到第一次 Layer 3 落地的檔案", async () => {
    const loreCtrl = JSON.stringify({
      state_changes: {
        touched_entities: [{ id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "撿到一根鐵管" }],
      },
    });
    let loreCall = 0;
    // Layer 3 全程走小模型（loreClient）：依序為 ①抽取 touched_entities ②生成 secrets ③整檔重寫 wiki
    const loreClient: LlmClient = {
      async *streamChat() {
        loreCall++;
        if (loreCall === 1) {
          await new Promise((r) => setTimeout(r, 50)); // 模擬較慢的 Layer 3 LLM（抽取階段）
          yield loreCtrl;
          return;
        }
        if (loreCall === 2) {
          yield "鐵管暗線真相內容"; // secrets 生成
          return;
        }
        yield "# 道具（rusty-pipe）\n\n比較重寫後的內容。"; // wiki 整檔重寫
      },
    };
    const pendingLoreSync = { promise: null as Promise<void> | null };
    const deps: TurnDeps = {
      client: fakeClient(["敘事內容。"]),
      controlClient: fakeClient([controlJson(true, "x")]),
      loreClient,
      pendingLoreSync,
      worldDir: world,
      commit: async () => true,
      today: () => "2026-06-19",
      dicePool: [1],
    };

    for await (const _ev of runMainSpaceTurn(deps, "撿東西")) {
      // 第一回合：done 立刻送出，Layer 3 在背景跑（50ms 後才完成）
    }
    for await (const _ev of runMainSpaceTurn(deps, "再做點別的事")) {
      // 第二回合一開始就 await 同一個 pendingLoreSync，理論上會等到第一回合的 Layer 3 落地
    }

    // secrets.md 已落地即證明第一回合的 Layer 3 在第二回合開始前完成（內容來自小模型 loreClient）
    const secrets = await readFile(path.join(world, "items", "rusty-pipe", "secrets.md"), "utf8");
    expect(secrets).toContain("鐵管暗線真相內容");
  });

  it("Layer 3 失敗（loreClient 拋錯）：下一回合仍正常開始、不拋錯", async () => {
    const loreClient: LlmClient = {
      async *streamChat() {
        throw new Error("Layer 3 LLM 掛了");
      },
    };
    const pendingLoreSync = { promise: null as Promise<void> | null };
    const deps: TurnDeps = {
      client: fakeClient(["敘事內容。"]),
      controlClient: fakeClient([controlJson(true, "x")]),
      loreClient,
      pendingLoreSync,
      worldDir: world,
      commit: async () => true,
      today: () => "2026-06-19",
      dicePool: [1],
    };

    const firstEvents: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "做點事")) firstEvents.push(ev);
    expect(firstEvents.some((e) => e.type === "done")).toBe(true);

    // 下一回合一開始 await pendingLoreSync.promise；即使上一回合 Layer 3 拋錯，也不該讓這裡拋錯
    const secondEvents: TurnEvent[] = [];
    await expect(
      (async () => {
        for await (const ev of runMainSpaceTurn(deps, "再做點事")) secondEvents.push(ev);
      })(),
    ).resolves.not.toThrow();
    expect(secondEvents.some((e) => e.type === "done")).toBe(true);
  });
});

describe("done.state 降級", () => {
  it("done 前 loadState 失敗時，done 不帶 state 且回合仍正常結束", async () => {
    const ctrl = JSON.stringify({
      state_changes: {},
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: [],
      commit_summary: "回合",
    });

    const real = contextMod.loadState;
    let calls = 0;
    const spy = vi.spyOn(contextMod, "loadState").mockImplementation(async (dir, logger) => {
      calls += 1;
      if (calls >= 2) throw new Error("模擬 loadState 失敗");
      return real(dir, logger);
    });

    try {
      const events: TurnEvent[] = [];
      for await (const ev of runMainSpaceTurn(
        {
          client: fakeClient(["一段敘事。"]),
          controlClient: fakeClient([ctrl]),
          worldDir: world,
          commit: async () => true,
          today: () => "2026-06-19",
          dicePool: [10, 20],
        },
        "看看四周",
      )) {
        events.push(ev);
      }

      const done: any = events.at(-1);
      expect(done.type).toBe("done");
      expect(done.state).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("journal_summary.md 寫入", () => {
  it("主空間回合結束後 journal_summary.md 多一行，mode 為主空間", async () => {
    const response =
      "沈奕做了某事。\n===STATE===\n" +
      JSON.stringify({
        state_changes: {}, rolls: [], mode_transition: null,
        awaiting_user_input: true, suggested_actions: [], commit_summary: "沈奕做了某事",
      });
    const deps: TurnDeps = {
      client: fakeClient([response]),
      worldDir: world,
      commit: async () => true,
      today: () => "2026-06-19",
      now: () => "2026-06-19T12:00:00",
      dicePool: [1],
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "行動")) events.push(ev);

    const md = await readFile(path.join(world, "journal_summary.md"), "utf8");
    expect(md.trim()).toBe("- [2026-06-19T12:00:00] (主空間) 沈奕做了某事");
  });

  it("副本回合結束後 journal_summary.md mode 標記為 副本:<id>", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    const ctrlJson = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: null,
      awaiting_user_input: true, suggested_actions: [], commit_summary: "進入大廳",
    });
    const response = "你踏入大廳。\n===STATE===\n" + ctrlJson;
    const deps: TurnDeps = {
      client: fakeClient([response]),
      worldDir: world,
      commit: async () => true,
      today: () => "2026-06-19",
      now: () => "2026-06-19T12:00:00",
      dicePool: [5],
    };
    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(deps, "往前走")) events.push(ev);

    const md = await readFile(path.join(world, "journal_summary.md"), "utf8");
    expect(md.trim()).toBe("- [2026-06-19T12:00:00] (副本:U-001) 進入大廳");
  });
});

describe("nudgeBlock / pacingBlock 整合", () => {
  it("nudgeBlock 命中時出現在主空間 system prompt", async () => {
    for (let i = 0; i < 5; i++) {
      await writeFile(
        path.join(world, "journal_summary.md"),
        `- [2026-06-19T10:0${i}:00] (主空間) 重複${i}\n`,
        { flag: "a" },
      );
    }
    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        if (!capturedSystem) capturedSystem = msgs[0].content;
        yield `敘事\n===STATE===\n${JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        })}`;
      },
    };
    const embedder = fakeEmbedder({ 重複0: [1, 0], 重複1: [1, 0], 重複2: [1, 0], 重複3: [1, 0], 重複4: [1, 0] });
    const deps: TurnDeps = {
      client: mainClient, worldDir: world, commit: async () => false,
      today: () => "2026-06-19", dicePool: [50], embedder, nudgeWindowSize: 5, nudgeSimilarityThreshold: 0.9,
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "繼續")) events.push(ev);

    expect(capturedSystem).toContain("## 節奏建議（短期）");
  });

  it("pacingBlock 命中時出現在副本 system prompt", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    await writeFile(path.join(world, "journal_summary.md"), "- [2026-06-19T09:00:00] (主空間) 之前的事\n");

    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        if (!capturedSystem) capturedSystem = msgs[0].content;
        yield `敘事\n===STATE===\n${JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        })}`;
      },
    };
    const pacingClient: LlmClient = { async *streamChat() { yield "這層拖太久了，該升級張力。"; } };
    const deps: TurnDeps = {
      client: mainClient, worldDir: world, commit: async () => false,
      today: () => "2026-06-19", dicePool: [5], pacingClient, pacingReviewInterval: 1,
    };
    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(deps, "往前走")) events.push(ev);

    expect(capturedSystem).toContain("## 節奏建議（長期，劇本大師）");
    expect(capturedSystem).toContain("這層拖太久了，該升級張力。");
  });

  it("沒有 journal_summary.md 時不出現任何節奏建議標題（預設情境）", async () => {
    let capturedSystem = "";
    const mainClient: LlmClient = {
      async *streamChat(msgs) {
        capturedSystem = msgs[0].content;
        yield `敘事\n===STATE===\n${JSON.stringify({
          state_changes: {}, rolls: [], mode_transition: null,
          awaiting_user_input: true, suggested_actions: [], commit_summary: "test",
        })}`;
      },
    };
    const deps: TurnDeps = {
      client: mainClient, worldDir: world, commit: async () => false,
      today: () => "2026-06-19", dicePool: [50],
    };
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "測試")) events.push(ev);

    expect(capturedSystem).not.toContain("## 節奏建議");
  });
});

describe("主角永久死亡（protagonist_permanent_death）", () => {
  it("control 標記永久死亡時：寫 .pending-death、覆寫 nextStep、強制 awaiting=true、done 帶 protagonistDied", async () => {
    const ctrl = JSON.stringify({
      state_changes: {},
      rolls: [],
      mode_transition: "settle_dungeon",
      awaiting_user_input: false, // 模型給 false，引擎必須覆寫成 true
      protagonist_permanent_death: true,
      suggested_actions: ["再來一次"],
      commit_summary: "主角戰死",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["沈奕倒下了，這次沒有豁免額度。"]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "拚死一搏",
    )) {
      events.push(ev);
    }

    const done: any = events.at(-1);
    expect(done.type).toBe("done");
    expect(done.protagonistDied).toBe(true);
    expect(done.awaitingUserInput).toBe(true); // 即使模型回 false 也被覆寫

    const pending = await readFile(path.join(world, ".pending-death"), "utf8");
    expect(pending.trim().length).toBeGreaterThan(0);

    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("等待抉擇：保留世界換主角 / 結束世界");
  });

  it("一般回合（無永久死亡）：不寫 .pending-death、done.protagonistDied 為 false", async () => {
    const ctrl = JSON.stringify({
      state_changes: {},
      rolls: [],
      mode_transition: null,
      awaiting_user_input: true,
      suggested_actions: [],
      commit_summary: "平安無事",
    });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["風平浪靜。"]),
        controlClient: fakeClient([ctrl]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "休息",
    )) {
      events.push(ev);
    }
    const done: any = events.at(-1);
    expect(done.protagonistDied).toBe(false);
    await expect(readFile(path.join(world, ".pending-death"), "utf8")).rejects.toThrow();
  });
});

describe("opening turn injection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "opening-"));
    const worldDir = path.join(dir, "world");
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    await mkdir(path.join(dir, "templates"), { recursive: true });
    // 世界已初始化（有 setting.md）
    await writeFile(path.join(worldDir, "setting.md"), "# 世界設定\n\n## 基本規則\n測試規則。\n");
    await writeFile(path.join(worldDir, "characters", "protagonist.md"), "# 主角檔案\n\n- 姓名：測試者\n\n## 積分\n\n1000\n");
    await writeFile(path.join(worldDir, "characters", "index.md"), "# 角色索引\n\n| ID | 姓名 | 定位 | 最近狀態 | 最後更新副本 |\n|----|------|------|----------|--------------|\n");
    await writeFile(path.join(worldDir, "now.md"), "# 當前局勢\n\n- 當前篇章：第一章：開場\n- 此刻場景/地點：主神空間\n- 在場同伴/相關 NPC：（無）\n- 進行中的副本：無\n- 未解懸念/伏筆：無\n- 主角下一步打算：\n- 最後更新：[2026-06-27] 進入主神空間\n");
    await writeFile(path.join(dir, "templates", "opening.md"), "開場回合專屬指引：測試內容。");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it(".pending-opening が存在する場合 system prompt に opening.md 内容が注入される", async () => {
    const worldDir = path.join(dir, "world");
    // initWorld 直後：.pending-opening が存在する（lastUpdated の文字列は関係ない）
    await writeFile(path.join(worldDir, ".pending-opening"), new Date().toISOString(), "utf8");
    await writeFile(path.join(worldDir, "journal.md"), "# 主空間日誌（Journal）\n\n## [2026-06-27] 新世界啟用\n\n開場敘事。\n");
    // now.md は beforeEach で設定済み（lastUpdated の値は問わない）

    const captured: ChatMessage[][] = [];
    const client: LlmClient = {
      async *streamChat(messages) {
        captured.push(messages);
        yield "opening 敘事";
      },
    };
    const controlClient = fakeClient([controlJson(true, "opening")]);

    const deps: TurnDeps = {
      client,
      controlClient,
      worldDir,
      commit: async () => false,
    };

    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "")) {
      events.push(ev);
    }

    // Layer 1 system prompt 應包含 opening.md 內容
    expect(captured[0][0].content).toContain("開場回合專屬指引：測試內容。");
  });

  it(".pending-opening 存在し lastUpdated が通常値のとき opening prompt が注入される", async () => {
    const worldDir = path.join(dir, "world");
    await writeFile(path.join(worldDir, ".pending-opening"), new Date().toISOString(), "utf8");
    // lastUpdated は「進入主神空間」を含まない — 旧コードはここで opening を注入しない
    await writeFile(path.join(worldDir, "now.md"), "# 當前局勢\n\n- 當前篇章：第一章：開場\n- 此刻場景/地點：主神空間\n- 在場同伴/相關 NPC：（無）\n- 進行中的副本：無\n- 未解懸念/伏筆：無\n- 主角下一步打算：\n- 最後更新：[2026-06-28] 第一回合開始\n");
    await writeFile(path.join(worldDir, "journal.md"), "# 主空間日誌（Journal）\n\n## [2026-06-28] 新世界啟用\n\n開場敘事。\n");

    const captured: ChatMessage[][] = [];
    const client: LlmClient = {
      async *streamChat(messages) { captured.push(messages); yield "opening 敘事"; },
    };
    const controlClient = fakeClient([controlJson(true, "opening")]);
    const deps: TurnDeps = { client, controlClient, worldDir, commit: async () => false };

    for await (const _ of runMainSpaceTurn(deps, "")) { /* drain */ }

    expect(captured[0][0].content).toContain("開場回合專屬指引：測試內容。");
  });

  it("開場回合完成後 .pending-opening が削除される", async () => {
    const worldDir = path.join(dir, "world");
    await writeFile(path.join(worldDir, ".pending-opening"), new Date().toISOString(), "utf8");
    await writeFile(path.join(worldDir, "journal.md"), "# 主空間日誌（Journal）\n\n## [2026-06-28] 新世界啟用\n\n開場敘事。\n");

    const client = fakeClient(["opening 敘事"]);
    const controlClient = fakeClient([controlJson(true, "opening")]);
    const deps: TurnDeps = { client, controlClient, worldDir, commit: async () => false };

    for await (const _ of runMainSpaceTurn(deps, "")) { /* drain */ }

    await expect(readFile(path.join(worldDir, ".pending-opening"), "utf8")).rejects.toThrow();
  });

  it("now.md の lastUpdated に「進入主神空間」が含まれない場合、opening.md 内容は注入されない", async () => {
    const worldDir = path.join(dir, "world");
    // 既に回合が進んだ状態：lastUpdated が通常の回合内容に更新済み
    await writeFile(path.join(worldDir, "now.md"), "# 當前局勢\n\n- 當前篇章：第一章：開場\n- 此刻場景/地點：主神空間\n- 在場同伴/相關 NPC：（無）\n- 進行中的副本：無\n- 未解懸念/伏筆：無\n- 主角下一步打算：\n- 最後更新：[2026-06-27] 主角觀察了四周\n");
    await writeFile(path.join(worldDir, "journal.md"), "# 主空間日誌（Journal）\n\n## [2026-06-27] 新世界啟用\n\n開場敘事。\n\n## [2026-06-27] 第一回合\n\n一段敘事。\n");

    const captured: ChatMessage[][] = [];
    const client: LlmClient = {
      async *streamChat(messages) {
        captured.push(messages);
        yield "正常敘事";
      },
    };
    const controlClient = fakeClient([controlJson(true, "normal")]);

    const deps: TurnDeps = {
      client,
      controlClient,
      worldDir,
      commit: async () => false,
    };

    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(deps, "任意行動")) {
      events.push(ev);
    }

    expect(captured[0][0].content).not.toContain("開場回合專屬指引：測試內容。");
  });
});
