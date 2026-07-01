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
    worldDir: "/tmp/world",
    recall: { enabled: false, indexDir: "/tmp/idx", topK: 5 },
    nudge: { windowSize: 20, similarityThreshold: 0.85 },
    pacingReviewInterval: 50,
    usageLogPath,
    typewriterIntervalMs: 25,
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

  it("chat() 成功：回傳完整字串並寫入 usage log", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "client-test-"));
    const usageLogPath = path.join(dir, "usage.log");
    createMock.mockResolvedValue({
      choices: [{ message: { content: "你好世界" } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const { createOpenAiClient } = await import("./client.js");
    const client = createOpenAiClient(makeConfig(usageLogPath), undefined, { label: "ctrl" });
    const result = await client.chat([{ role: "user", content: "hi" }]);
    expect(result).toBe("你好世界");

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ stream: false }),
    );
    // 不應帶 stream_options（那是串流專用）
    expect(createMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ stream_options: expect.anything() }),
    );

    const logged = JSON.parse((await readFile(usageLogPath, "utf8")).trim());
    expect(logged).toMatchObject({
      label: "ctrl",
      model: "test-model",
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
    });
    expect(typeof logged.durationMs).toBe("number");
  });

  it("chat() content 為 null 時拋錯，不寫 usage log", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "client-test-"));
    const usageLogPath = path.join(dir, "usage.log");
    createMock.mockResolvedValue({
      choices: [{ message: { content: null } }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    });

    const { createOpenAiClient } = await import("./client.js");
    const client = createOpenAiClient(makeConfig(usageLogPath));
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow("LLM 回傳空 content");

    const exists = await readFile(usageLogPath, "utf8").catch(() => null);
    expect(exists).toBeNull();
  });

  it("chat() 失敗：拋錯，不寫 usage log", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "client-test-"));
    const usageLogPath = path.join(dir, "usage.log");
    createMock.mockRejectedValue(new Error("timeout"));

    const { createOpenAiClient } = await import("./client.js");
    const client = createOpenAiClient(makeConfig(usageLogPath));
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow("timeout");

    const exists = await readFile(usageLogPath, "utf8").catch(() => null);
    expect(exists).toBeNull();
  });
});
