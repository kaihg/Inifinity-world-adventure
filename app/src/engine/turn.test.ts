import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../llm/client.js";
import { runMainSpaceTurn, buildMainSpaceMessages, type TurnEvent } from "./turn.js";
import type { GameState } from "./context.js";

function fakeClient(deltas: string[]): LlmClient {
  return {
    async *streamChat(_messages: ChatMessage[]): AsyncIterable<string> {
      for (const d of deltas) yield d;
    },
  };
}

let world: string;
beforeEach(async () => {
  world = await mkdtemp(path.join(tmpdir(), "iwa-turn-"));
  await mkdir(path.join(world, "characters"), { recursive: true });
  await writeFile(path.join(world, "setting.md"), "# 設定\n規則：禁止竄改數值。\n");
  await writeFile(
    path.join(world, "now.md"),
    "# 當前局勢\n- 當前篇章：第一章\n- 此刻場景/地點：安全區\n- 進行中的副本：無\n- 最後更新：[2026-06-18] 舊\n",
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
  it("system 含設定規則與當前 canonical context，user 為玩家輸入", () => {
    const state: GameState = {
      now: {
        chapter: "第一章", scene: "安全區", companions: "葉晴",
        activeDungeon: "無", threads: "", nextStep: "", lastUpdated: "",
      },
      protagonist: { name: "沈奕", points: "0" },
      mode: "main-space",
    };
    const msgs = buildMainSpaceMessages({ settingText: "禁止竄改數值。", state, input: "我四處看看" });
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("禁止竄改數值");
    expect(msgs[0].content).toContain("沈奕");
    expect(msgs[0].content).toContain("安全區");
    expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "我四處看看" });
  });
});

describe("runMainSpaceTurn", () => {
  it("串流 delta、落地 journal、覆寫 now 時間戳、commit 一次", async () => {
    const commits: string[] = [];
    const events: TurnEvent[] = [];
    for await (const ev of runMainSpaceTurn(
      {
        client: fakeClient(["沈奕環顧四周，", "安全區一切如常。"]),
        worldDir: world,
        commit: async (m) => { commits.push(m); return true; },
        today: () => "2026-06-19",
      },
      "我四處看看",
    )) {
      events.push(ev);
    }

    const deltas = events.filter((e) => e.type === "delta").map((e) => (e as any).text);
    expect(deltas).toEqual(["沈奕環顧四周，", "安全區一切如常。"]);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect((done as any).narrative).toBe("沈奕環顧四周，安全區一切如常。");
    expect((done as any).committed).toBe(true);

    const journal = await readFile(path.join(world, "journal.md"), "utf8");
    expect(journal).toContain("## [2026-06-19]");
    expect(journal).toContain("安全區一切如常");
    expect(journal).toContain("我四處看看");

    const now = await readFile(path.join(world, "now.md"), "utf8");
    expect(now).toContain("- 最後更新：[2026-06-19]");
    expect(now).not.toContain("[2026-06-18] 舊");

    expect(commits).toHaveLength(1);
    expect(commits[0].length).toBeGreaterThan(0);
  });
});
