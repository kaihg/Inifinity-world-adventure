import { describe, it, expect } from "vitest";
import { applyEnvUpdates } from "./config-file.js";

describe("applyEnvUpdates", () => {
  it("更新既有 key，新增不存在的 key", () => {
    const existing = "OPENAI_BASE_URL=http://old\nMODEL=gpt-4o\nPORT=5173\n";
    const out = applyEnvUpdates(existing, { MODEL: "qwen2.5", OPENAI_API_KEY: "sk-new" });
    expect(out).toContain("MODEL=qwen2.5");
    expect(out).not.toContain("MODEL=gpt-4o");
    expect(out).toContain("OPENAI_BASE_URL=http://old"); // 未動
    expect(out).toContain("OPENAI_API_KEY=sk-new"); // 新增
  });

  it("不破壞註解行", () => {
    const out = applyEnvUpdates("# 註解\nMODEL=a\n", { MODEL: "b" });
    expect(out).toContain("# 註解");
    expect(out).toContain("MODEL=b");
  });
});
