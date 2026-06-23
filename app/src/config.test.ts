import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadConfig, configWarnings } from "./config.js";

describe("loadConfig", () => {
  it("空 env 回傳合理預設值", () => {
    const c = loadConfig({});
    expect(c.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(c.openai.model).toBe("gpt-4o");
    expect(c.openai.apiKey).toBe("");
    expect(c.port).toBe(5173);
    expect(c.autoAdvanceMax).toBe(4);
    expect(c.git.authorName).toBe("Infinity World Engine");
  });

  it("讀取提供的 env 值", () => {
    const c = loadConfig({
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      OPENAI_API_KEY: "sk-test",
      MODEL: "qwen2.5",
      PORT: "8080",
      AUTO_ADVANCE_MAX: "2",
      GIT_AUTHOR_NAME: "Me",
      GIT_AUTHOR_EMAIL: "me@x.com",
    });
    expect(c.openai.baseUrl).toBe("http://localhost:11434/v1");
    expect(c.openai.apiKey).toBe("sk-test");
    expect(c.openai.model).toBe("qwen2.5");
    expect(c.port).toBe(8080);
    expect(c.autoAdvanceMax).toBe(2);
    expect(c.git.authorEmail).toBe("me@x.com");
  });

  it("PORT / AUTO_ADVANCE_MAX 解析為數字，非法值退回預設", () => {
    const c = loadConfig({ PORT: "not-a-number", AUTO_ADVANCE_MAX: "-3" });
    expect(c.port).toBe(5173);
    expect(c.autoAdvanceMax).toBe(4);
    expect(typeof c.port).toBe("number");
  });

  it("worldDir 預設為絕對路徑、指向 repo 的 world 目錄", () => {
    const c = loadConfig({});
    expect(path.isAbsolute(c.worldDir)).toBe(true);
    expect(path.basename(c.worldDir)).toBe("world");
  });

  it("WORLD_DIR 可覆寫", () => {
    const c = loadConfig({ WORLD_DIR: "/tmp/custom-world" });
    expect(c.worldDir).toBe("/tmp/custom-world");
  });

  it("usageLogPath 預設為絕對路徑、指向 app/.llm-usage.log", () => {
    const c = loadConfig({});
    expect(path.isAbsolute(c.usageLogPath)).toBe(true);
    expect(path.basename(c.usageLogPath)).toBe(".llm-usage.log");
  });

  it("USAGE_LOG_PATH 可覆寫", () => {
    const c = loadConfig({ USAGE_LOG_PATH: "/tmp/custom-usage.log" });
    expect(c.usageLogPath).toBe("/tmp/custom-usage.log");
  });

  it("character 欄位：有設定時解析", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1",
      OPENAI_API_KEY: "key",
      MODEL: "main-model",
      CHARACTER_OPENAI_BASE_URL: "http://char/v1",
      CHARACTER_MODEL: "qwen2.5:3b",
    });
    expect(config.character).toEqual({
      baseUrl: "http://char/v1",
      model: "qwen2.5:3b",
    });
  });

  it("character 欄位：未設定時為 undefined", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1",
      OPENAI_API_KEY: "key",
      MODEL: "main-model",
    });
    expect(config.character).toBeUndefined();
  });

  it("control 欄位：有設定時解析", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1",
      OPENAI_API_KEY: "key",
      MODEL: "main-model",
      CONTROL_OPENAI_BASE_URL: "http://ctrl/v1",
      CONTROL_MODEL: "qwen2.5:7b",
    });
    expect(config.control).toEqual({
      baseUrl: "http://ctrl/v1",
      model: "qwen2.5:7b",
    });
  });

  it("control 欄位：未設定時為 undefined", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1",
      OPENAI_API_KEY: "key",
      MODEL: "main-model",
    });
    expect(config.control).toBeUndefined();
  });

  it("lore 欄位：有設定時解析", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1",
      OPENAI_API_KEY: "key",
      MODEL: "main-model",
      LORE_OPENAI_BASE_URL: "http://lore/v1",
      LORE_MODEL: "qwen2.5:7b",
    });
    expect(config.lore).toEqual({
      baseUrl: "http://lore/v1",
      model: "qwen2.5:7b",
    });
  });

  it("lore 欄位：未設定時為 undefined", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1",
      OPENAI_API_KEY: "key",
      MODEL: "main-model",
    });
    expect(config.lore).toBeUndefined();
  });

  it("nudge 設定預設值", () => {
    const c = loadConfig({});
    expect(c.nudge.windowSize).toBe(5);
    expect(c.nudge.similarityThreshold).toBeCloseTo(0.92);
  });

  it("nudge 設定可由環境變數覆寫", () => {
    const c = loadConfig({ NUDGE_WINDOW_SIZE: "8", NUDGE_SIMILARITY_THRESHOLD: "0.8" });
    expect(c.nudge.windowSize).toBe(8);
    expect(c.nudge.similarityThreshold).toBeCloseTo(0.8);
  });

  it("NUDGE_SIMILARITY_THRESHOLD 超出 0~1 範圍或非數字時退回預設", () => {
    expect(loadConfig({ NUDGE_SIMILARITY_THRESHOLD: "2" }).nudge.similarityThreshold).toBeCloseTo(0.92);
    expect(loadConfig({ NUDGE_SIMILARITY_THRESHOLD: "abc" }).nudge.similarityThreshold).toBeCloseTo(0.92);
  });

  it("NUDGE_WINDOW_SIZE 非正整數時退回預設", () => {
    expect(loadConfig({ NUDGE_WINDOW_SIZE: "-1" }).nudge.windowSize).toBe(5);
  });

  it("pacingReviewInterval 預設 10，可由環境變數覆寫", () => {
    expect(loadConfig({}).pacingReviewInterval).toBe(10);
    expect(loadConfig({ PACING_REVIEW_INTERVAL: "20" }).pacingReviewInterval).toBe(20);
  });

  it("pacing 欄位：有設定時解析", () => {
    const config = loadConfig({
      OPENAI_BASE_URL: "http://main/v1", OPENAI_API_KEY: "key", MODEL: "main-model",
      PACING_OPENAI_BASE_URL: "http://pacing/v1", PACING_MODEL: "qwen2.5:7b",
    });
    expect(config.pacing).toEqual({ baseUrl: "http://pacing/v1", model: "qwen2.5:7b" });
  });

  it("pacing 欄位：未設定時為 undefined", () => {
    expect(loadConfig({ OPENAI_API_KEY: "key" }).pacing).toBeUndefined();
  });
});

describe("configWarnings", () => {
  it("缺 API key 時提出警示", () => {
    const warnings = configWarnings(loadConfig({}));
    expect(warnings.some((w) => w.includes("OPENAI_API_KEY"))).toBe(true);
  });

  it("齊全設定無警示", () => {
    const warnings = configWarnings(
      loadConfig({ OPENAI_API_KEY: "sk-test" }),
    );
    expect(warnings).toHaveLength(0);
  });
});
