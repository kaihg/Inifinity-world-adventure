import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import { appendJournalSummary } from "../journal-summary.js";
import { runPacingBlock } from "./pacing.js";
import type { TurnDeps, TurnEvent } from "./types.js";
import type { GameState } from "../context.js";

function fakeClient(deltas: string[] | (() => never)): LlmClient {
  return {
    async *streamChat(_m: ChatMessage[]): AsyncIterable<string> {
      if (typeof deltas === "function") deltas();
      else for (const d of deltas) yield d;
    },
  };
}

async function collect(gen: AsyncGenerator<TurnEvent, string>): Promise<{ events: TurnEvent[]; result: string }> {
  const events: TurnEvent[] = [];
  let result = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await gen.next();
    if (done) { result = value; break; }
    events.push(value as TurnEvent);
  }
  return { events, result };
}

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

let world: string;
beforeEach(async () => {
  world = await mkdtemp(path.join(tmpdir(), "iwa-pacing-"));
});
afterEach(async () => {
  await rm(world, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return {
    client: fakeClient([]),
    worldDir: world,
    commit: async () => false,
    ...overrides,
  };
}

describe("runPacingBlock", () => {
  it("journal_summary.md 不存在（0 筆）時不呼叫 LLM，回傳空字串", async () => {
    let called = false;
    const pacingClient = fakeClient(() => { called = true; throw new Error("不該被呼叫"); });
    const { result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 2 }), makeFakeState(), "設定"),
    );
    expect(result).toBe("");
    expect(called).toBe(false);
  });

  it("行數不是 K 的倍數時不呼叫 LLM", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    let called = false;
    const pacingClient = fakeClient(() => { called = true; throw new Error("不該被呼叫"); });
    const { result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 2 }), makeFakeState(), "設定"),
    );
    expect(result).toBe("");
    expect(called).toBe(false);
  });

  it("行數是 K 的倍數時呼叫 LLM，回傳格式化內容", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    await appendJournalSummary(world, { timestamp: "t2", mode: "主空間", summary: "B" });
    const pacingClient = fakeClient(["該開新副本了。"]);
    const { result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 2 }), makeFakeState(), "設定"),
    );
    expect(result).toContain("## 節奏建議（長期，劇本大師）");
    expect(result).toContain("該開新副本了。");
  });

  it("deps.pacingClient 優先於 controlClient/client", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    const wrongClient = fakeClient(() => { throw new Error("不該被呼叫這個"); });
    const pacingClient = fakeClient(["正確的建議"]);
    const { result } = await collect(
      runPacingBlock(
        baseDeps({ client: wrongClient, controlClient: wrongClient, pacingClient, pacingReviewInterval: 1 }),
        makeFakeState(),
        "設定",
      ),
    );
    expect(result).toContain("正確的建議");
  });

  it("LLM 回應 trim 後為空字串時回傳空字串", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    const pacingClient = fakeClient(["   \n  "]);
    const { result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 1 }), makeFakeState(), "設定"),
    );
    expect(result).toBe("");
  });

  it("LLM 呼叫失敗時降級回傳空字串並 yield warning", async () => {
    await appendJournalSummary(world, { timestamp: "t1", mode: "主空間", summary: "A" });
    const pacingClient = fakeClient(() => { throw new Error("LLM 掛了"); });
    const { events, result } = await collect(
      runPacingBlock(baseDeps({ pacingClient, pacingReviewInterval: 1 }), makeFakeState(), "設定"),
    );
    expect(result).toBe("");
    expect(events.some((e) => e.type === "warning")).toBe(true);
  });
});
