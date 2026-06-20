import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { readdir } from "node:fs/promises";
import { runMainSpaceTurn, runDungeonTurn, runTurnLoop, buildMainSpaceMessages, type TurnEvent, type TurnDeps } from "./turn.js";
import type { GameState } from "./context.js";
import type { RecallHit, RecallIndex } from "../recall/store.js";

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

function control(awaiting: boolean, summary: string): string {
  return (
    `敘事：${summary}\n===STATE===\n` +
    JSON.stringify({
      state_changes: {},
      rolls: [],
      mode_transition: null,
      awaiting_user_input: awaiting,
      suggested_actions: [],
      commit_summary: summary,
    })
  );
}

const sampleState: GameState = {
  now: {
    chapter: "第一章", scene: "安全區", companions: "葉晴",
    activeDungeon: "無", threads: "", nextStep: "", lastUpdated: "",
  },
  protagonist: { name: "沈奕", points: "0" },
  protagonistDetail: { name: "沈奕", points: "0", attributes: "", skills: "", items: "", buffs: "" },
  npcs: [],
  mode: "main-space",
  lastTurn: null,
};

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

function makeFakeState(): GameState {
  return {
    now: { chapter: "c", scene: "s", companions: "", activeDungeon: "無", threads: "", nextStep: "", lastUpdated: "" },
    protagonist: { name: "沈奕", points: "100" },
    protagonistDetail: { name: "沈奕", points: "100", attributes: "", skills: "", items: "", buffs: "" },
    npcs: [],
    mode: "main-space",
    lastTurn: null,
  };
}

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

describe("buildMainSpaceMessages", () => {
  it("system 含設定、canonical、輸出格式與骰值；user 為玩家輸入", () => {
    const msgs = buildMainSpaceMessages({
      settingText: "禁止竄改數值。", state: sampleState, input: "我四處看看", dicePool: [7, 42],
    });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁止竄改數值");
    expect(msgs[0].content).toContain("===STATE===");
    expect(msgs[0].content).toContain("awaiting_user_input");
    expect(msgs[0].content).toContain("[7, 42]");
    expect(msgs[1]).toEqual({ role: "user", content: "我四處看看" });
  });

  it("intentsBlock 有值時出現在 system prompt", () => {
    const params = {
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      intentsBlock: "## 在場角色本回合意圖\n### 葉晴（yeqing）\n- 立場：觀察",
    };
    const msgs = buildMainSpaceMessages(params);
    expect(msgs[0].content).toContain("## 在場角色本回合意圖");
  });

  it("intentsBlock 為空字串時 system prompt 不含意圖區塊標題", () => {
    const params = {
      settingText: "設定",
      state: makeFakeState(),
      input: "行動",
      dicePool: [50],
      intentsBlock: "",
    };
    const msgs = buildMainSpaceMessages(params);
    expect(msgs[0].content).not.toContain("## 在場角色本回合意圖");
  });
});

describe("runMainSpaceTurn — 結構化輸出", () => {
  it("串流敘事、套用 now/積分、commit，done 帶 awaitingUserInput/suggestedActions", async () => {
    const commits: string[] = [];
    const response =
      "沈奕走進資訊室。\n===STATE===\n" +
      JSON.stringify({
        state_changes: { now: { scene: "資訊室", nextStep: "找葉晴" }, protagonist_points_delta: 2 },
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: ["找葉晴", "離開"],
        commit_summary: "沈奕進資訊室",
      });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient([response]),
        worldDir: world,
        commit: async (m) => { commits.push(m); return true; },
        today: () => "2026-06-19",
        dicePool: [10, 20],
      },
      "去資訊室",
    )) {
      events.push(ev);
    }

    const narrative = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
    expect(narrative).toContain("沈奕走進資訊室。");
    expect(narrative).not.toContain("===STATE===");

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

    expect(commits).toEqual(["沈奕進資訊室"]);
  });

  it("protagonist_updates 落地到 protagonist.md 對應區塊（主角成長記憶）", async () => {
    await writeFile(
      path.join(world, "characters", "protagonist.md"),
      [
        "# 主角",
        "- 姓名：沈奕",
        "- 當前積分：0",
        "",
        "## 技能 / 異能",
        "- （無）",
        "",
        "## 物品欄",
        "- 戰術刀",
        "",
      ].join("\n"),
      "utf8",
    );
    const response =
      "沈奕領悟了一套新的格鬥技巧，並從地上拾起一根鐵管。\n===STATE===\n" +
      JSON.stringify({
        state_changes: {
          protagonist_points_delta: 1,
          protagonist_updates: { skills: ["近戰格鬥精通"], items: ["生鏽鐵管"] },
        },
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "沈奕成長",
      });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient([response]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
        dicePool: [1],
      },
      "練習格鬥",
    )) {
      events.push(ev);
    }
    const prot = await readFile(path.join(world, "characters", "protagonist.md"), "utf8");
    expect(prot).toContain("- 當前積分：1");
    expect(prot).toContain("- （無）\n- 近戰格鬥精通");
    expect(prot).toContain("- 戰術刀\n- 生鏽鐵管");
  });

  it("npc_updates 同步用小模型摘要進 characters/index.md 的最近狀態欄", async () => {
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
    const response =
      "葉晴點點頭，眼神多了幾分信任。\n===STATE===\n" +
      JSON.stringify({
        state_changes: { npc_updates: [{ id: "yeqing", update: "對沈奕的信任進一步提升" }] },
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "葉晴信任提升",
      });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient([response]),
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
    const index = await readFile(path.join(world, "characters", "index.md"), "utf8");
    expect(index).toContain("| yeqing | 葉晴 | NPC | 信任大幅提升 | - |");
  });

  it("npc_updates 落地到對應 characters/<id>.md（NPC 長期記憶）", async () => {
    await writeFile(path.join(world, "characters", "yeqing.md"), "# 葉晴\n前特種部隊教官\n", "utf8");
    const response =
      "葉晴點點頭，眼神多了幾分信任。\n===STATE===\n" +
      JSON.stringify({
        state_changes: { npc_updates: [{ id: "yeqing", update: "對沈奕的信任進一步提升" }] },
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "葉晴信任提升",
      });
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient([response]),
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
    expect(yeqing).toContain("## [2026-06-19] 更新");
    expect(yeqing).toContain("對沈奕的信任進一步提升");
  });

  it("缺 sentinel 時降級：保留敘事、發 warning、暫停、仍 commit", async () => {
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["這是一段沒有控制區塊的純敘事。"]),
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
    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("- 最後更新：[2026-06-19]");
  });
});

describe("runTurnLoop — 自動推進", () => {
  it("awaiting_user_input=false 時自動接續，遇 true 停止", async () => {
    const events: TurnEvent[] = [];
    for await (const ev of runTurnLoop(
      {
        client: sequencedClient([control(false, "系統倒數推進"), control(true, "需要玩家決定")]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
      },
      "等待",
      3,
    )) {
      events.push(ev);
    }
    const dones = events.filter((e) => e.type === "done") as any[];
    expect(dones).toHaveLength(2);
    expect(dones[0].awaitingUserInput).toBe(false);
    expect(dones[1].awaitingUserInput).toBe(true);
    expect(events.some((e) => e.type === "auto-advance")).toBe(true);
  });

  it("達 maxAuto 上限即停（即使一直 false）", async () => {
    const events: TurnEvent[] = [];
    for await (const ev of runTurnLoop(
      {
        client: sequencedClient([control(false, "持續推進")]),
        worldDir: world,
        commit: async () => true,
        today: () => "2026-06-19",
      },
      "等待",
      2,
    )) {
      events.push(ev);
    }
    // 1 個初始 + 最多 2 個自動 = 最多 3 個 done
    const dones = events.filter((e) => e.type === "done");
    expect(dones).toHaveLength(3);
  });
});

describe("runDungeonTurn", () => {
  it("落地到 runs/*.md、提煉 wiki_reveals 進 wiki.md", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(path.join(world, "dungeons", "U-001", "secrets.md"), "真相：地板會塌\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    const response =
      "你踏入大廳，三道門並排。\n===STATE===\n" +
      JSON.stringify({
        state_changes: { wiki_reveals: ["入口大廳有三道門"] },
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "進入大廳",
      });

    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(
      { client: fakeClient([response]), worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [5] },
      "往前走",
    )) {
      events.push(ev);
    }

    const run = await readFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "utf8");
    expect(run).toContain("## [2026-06-19] 進入大廳");
    expect(run).toContain("往前走");
    const wiki = await readFile(path.join(world, "dungeons", "U-001", "wiki.md"), "utf8");
    expect(wiki).toContain("三道門");
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

    const worldDir = await makeTempWorld({ withYeqing: true });
    try {
      const deps: TurnDeps = {
        client: mainClient,
        characterClient: charClient,
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
      async *streamChat() {
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
    const worldDir = await makeTempWorld({ withYeqing: true });
    try {
      const deps: TurnDeps = {
        client: mainClient,
        characterClient: charClient,
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
    const recall = fakeRecall([{ file: "characters/yeqing.md", heading: "近況", text: "葉晴受傷了", score: 0.9 }]);

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

  it("副本回合結束後重新索引 run log 與 wiki（有 wiki_reveals 時）", async () => {
    await mkdir(path.join(world, "dungeons", "U-001", "runs"), { recursive: true });
    await writeFile(path.join(world, "dungeons", "U-001", "runs", "run-1.md"), "# run\n");
    await writeFile(path.join(world, "dungeons", "U-001", "secrets.md"), "真相：地板會塌\n");
    await writeFile(
      path.join(world, "now.md"),
      "- 當前篇章：第一章\n- 此刻場景/地點：副本\n- 進行中的副本：U-001 + run-1\n- 最後更新：[2026-06-18] 舊\n",
    );
    const response =
      "你踏入大廳，三道門並排。\n===STATE===\n" +
      JSON.stringify({
        state_changes: { wiki_reveals: ["入口大廳有三道門"] },
        rolls: [],
        mode_transition: null,
        awaiting_user_input: true,
        suggested_actions: [],
        commit_summary: "進入大廳",
      });

    const recall = fakeRecall();
    const events: TurnEvent[] = [];
    for await (const ev of runDungeonTurn(
      { client: fakeClient([response]), worldDir: world, commit: async () => true, today: () => "2026-06-19", dicePool: [5], recall },
      "往前走",
    )) {
      events.push(ev);
    }

    const relPaths = recall.upserted.map((u) => u.relPath);
    expect(relPaths).toContain(path.join("dungeons", "U-001", "runs", "run-1.md"));
    expect(relPaths).toContain(path.join("dungeons", "U-001", "wiki.md"));
  });
});

describe("runTurnLoop — 進入/結算副本（不切 branch）", () => {
  it("enter_dungeon → 生成 secrets/建 run → 副本回合 → settle_dungeon 回主空間", async () => {
    const enterCtl = JSON.stringify({
      state_changes: {}, rolls: [], mode_transition: "enter_dungeon",
      transition_dungeon_id: "U-TEST", awaiting_user_input: false, suggested_actions: [], commit_summary: "系統強制開啟副本",
    });
    const settleCtl = JSON.stringify({
      state_changes: { wiki_reveals: ["出口在東側"] }, rolls: [], mode_transition: "settle_dungeon",
      awaiting_user_input: true, suggested_actions: [], commit_summary: "撤離副本",
    });
    const client = sequencedClient([
      "系統警報響起。\n===STATE===\n" + enterCtl,   // call 0：主空間 → 進副本
      "這個副本真正的機關是潮汐淹沒。",              // call 1：secrets 生成（純文字）
      "你抵達出口。\n===STATE===\n" + settleCtl,    // call 2：副本回合 → 結算
    ]);

    const events: TurnEvent[] = [];
    for await (const ev of runTurnLoop(
      { client, worldDir: world, commit: async () => true, today: () => "2026-06-19" },
      "在安全區等待",
      4,
    )) {
      events.push(ev);
    }

    const transitions = events.filter((e) => e.type === "transition") as any[];
    expect(transitions.map((t) => t.to)).toEqual(["dungeon", "main-space"]);

    const secrets = await readFile(path.join(world, "dungeons", "U-TEST", "secrets.md"), "utf8");
    expect(secrets).toContain("潮汐淹沒");
    const runs = await readdir(path.join(world, "dungeons", "U-TEST", "runs"));
    expect(runs).toContain("run-1.md");
    const wiki = await readFile(path.join(world, "dungeons", "U-TEST", "wiki.md"), "utf8");
    expect(wiki).toContain("出口在東側");

    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("- 進行中的副本：無"); // 結算後回主空間
  });
});
