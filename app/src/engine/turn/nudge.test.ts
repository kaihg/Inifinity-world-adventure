import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { Embedder } from "../../recall/embedder.js";
import { appendJournalSummary } from "../journal-summary.js";
import { cosineSimilarity, runNudgeBlock } from "./nudge.js";
import type { TurnDeps, TurnEvent } from "./types.js";

function fakeClient(): LlmClient {
  return { async *streamChat(_m: ChatMessage[]): AsyncIterable<string> { yield ""; } };
}

function fakeEmbedder(vectorsByText: Record<string, number[]>, opts: { throwOnEmbed?: boolean } = {}): Embedder {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (opts.throwOnEmbed) throw new Error("嵌入模型掛了");
      return texts.map((t) => vectorsByText[t] ?? [0, 0]);
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

let world: string;
beforeEach(async () => {
  world = await mkdtemp(path.join(tmpdir(), "iwa-nudge-"));
});
afterEach(async () => {
  await rm(world, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<TurnDeps> = {}): TurnDeps {
  return {
    client: fakeClient(),
    worldDir: world,
    commit: async () => false,
    ...overrides,
  };
}

describe("cosineSimilarity", () => {
  it("相同向量相似度為 1", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });
  it("正交向量相似度為 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("任一為零向量時回傳 0（避免除零）", () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe("runNudgeBlock", () => {
  it("journal_summary.md 不存在時回傳空字串", async () => {
    const { result } = await collect(runNudgeBlock(baseDeps(), "隨便做點事"));
    expect(result).toBe("");
  });

  it("筆數不足 windowSize 時回傳空字串", async () => {
    await appendJournalSummary(world, { timestamp: "2026-06-23T10:00:00", mode: "主空間", summary: "A" });
    const { result } = await collect(runNudgeBlock(baseDeps(), "隨便做點事"));
    expect(result).toBe("");
  });

  it("連續高相似度時回傳建議文字（含節奏建議標題）", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `重複描述${i}` });
    }
    const embedder = fakeEmbedder({
      重複描述0: [1, 0], 重複描述1: [1, 0], 重複描述2: [1, 0], 重複描述3: [1, 0], 重複描述4: [1, 0],
    });
    const { result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), "隨便做點事"));
    expect(result).toContain("## 節奏建議（短期）");
  });

  it("窗口內有差異向量時不觸發，回傳空字串", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `描述${i}` });
    }
    const embedder = fakeEmbedder({
      描述0: [1, 0], 描述1: [0, 1], 描述2: [1, 0], 描述3: [0, 1], 描述4: [1, 0],
    });
    const { result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), "隨便做點事"));
    expect(result).toBe("");
  });

  it("命中時建議文字含玩家輸入方向提示", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `重複${i}` });
    }
    const embedder = fakeEmbedder({ 重複0: [1, 0], 重複1: [1, 0], 重複2: [1, 0], 重複3: [1, 0], 重複4: [1, 0] });
    const { result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), "推門進去，做好戰鬥準備"));
    expect(result).toContain("推門進去，做好戰鬥準備");
  });

  it("預設 windowSize（3）：3 筆連續高相似度即觸發（根因 H：窗口縮小才填得滿）", async () => {
    for (let i = 0; i < 3; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `鬼打牆${i}` });
    }
    const embedder = fakeEmbedder({ 鬼打牆0: [1, 0], 鬼打牆1: [1, 0], 鬼打牆2: [1, 0] });
    // 不傳 nudgeWindowSize，走預設值；3 筆即應觸發
    const { result } = await collect(runNudgeBlock(baseDeps({ embedder }), "隨便做點事"));
    expect(result).toContain("## 節奏建議（短期）");
  });

  it("embedder 拋例外時降級回傳空字串並 yield warning 事件", async () => {
    for (let i = 0; i < 5; i++) {
      await appendJournalSummary(world, { timestamp: `2026-06-23T10:0${i}:00`, mode: "主空間", summary: `x${i}` });
    }
    const embedder = fakeEmbedder({}, { throwOnEmbed: true });
    const { events, result } = await collect(runNudgeBlock(baseDeps({ embedder, nudgeWindowSize: 5 }), "測試"));
    expect(result).toBe("");
    expect(events.some((e) => e.type === "warning")).toBe(true);
  });
});
