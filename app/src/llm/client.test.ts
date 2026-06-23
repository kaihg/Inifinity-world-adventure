import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppConfig } from "../config.js";

const createMock = vi.fn();

vi.mock("openai", () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: createMock } };
  },
}));

async function* fakeStream(chunks: Array<{ content?: string; usage?: unknown }>) {
  for (const c of chunks) {
    yield {
      choices: [{ delta: { content: c.content } }],
      usage: c.usage ?? null,
    };
  }
}

function makeConfig(usageLogPath: string): AppConfig {
  return {
    openai: { baseUrl: "http://x/v1", apiKey: "k", model: "test-model" },
    port: 5173,
    host: "127.0.0.1",
    debug: false,
    logLevel: "silent",
    git: { authorName: "a", authorEmail: "a@x.com" },
    autoAdvanceMax: 4,
    worldDir: "/tmp/world",
    recall: { enabled: false, indexDir: "/tmp/idx", topK: 5 },
    nudge: { windowSize: 20, similarityThreshold: 0.85 },
    pacingReviewInterval: 50,
    usageLogPath,
  };
}

describe("createOpenAiClient usage logging", () => {
  let dir: string;

  afterEach(async () => {
    createMock.mockReset();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("串流結束後把 token 用量與耗時 append 進 usage log", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "client-test-"));
    const usageLogPath = path.join(dir, "usage.log");
    createMock.mockResolvedValue(
      fakeStream([
        { content: "你" },
        { content: "好" },
        { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      ]),
    );

    const { createOpenAiClient } = await import("./client.js");
    const client = createOpenAiClient(makeConfig(usageLogPath), undefined, { label: "main" });

    let full = "";
    for await (const d of client.streamChat([{ role: "user", content: "hi" }])) full += d;
    expect(full).toBe("你好");

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ stream_options: { include_usage: true } }),
    );

    const logged = JSON.parse((await readFile(usageLogPath, "utf8")).trim());
    expect(logged).toMatchObject({
      label: "main",
      model: "test-model",
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    });
    expect(typeof logged.durationMs).toBe("number");
  });

  it("label 缺省時退回 main", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "client-test-"));
    const usageLogPath = path.join(dir, "usage.log");
    createMock.mockResolvedValue(fakeStream([{ content: "x" }]));

    const { createOpenAiClient } = await import("./client.js");
    const client = createOpenAiClient(makeConfig(usageLogPath));
    for await (const _d of client.streamChat([{ role: "user", content: "hi" }])) {
      // drain
    }

    const logged = JSON.parse((await readFile(usageLogPath, "utf8")).trim());
    expect(logged.label).toBe("main");
  });
});
