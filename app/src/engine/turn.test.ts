import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { runMainSpaceTurn, runMainSpaceTurnLoop, buildMainSpaceMessages, type TurnEvent } from "./turn.js";
import type { GameState } from "./context.js";

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
  mode: "main-space",
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

describe("runMainSpaceTurnLoop — 自動推進", () => {
  it("awaiting_user_input=false 時自動接續，遇 true 停止", async () => {
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurnLoop(
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
    for await (const ev of runMainSpaceTurnLoop(
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
