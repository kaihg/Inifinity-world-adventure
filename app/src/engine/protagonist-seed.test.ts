import { describe, it, expect } from "vitest";
import { buildProtagonistPrompt, type ProtagonistSeed } from "./protagonist-seed.js";

describe("buildProtagonistPrompt", () => {
  it("有 name/origin/freeform 時，三者都出現在 prompt", () => {
    const seed: ProtagonistSeed = { name: "沈奕", origin: "地下拳手", freeform: "重情義" };
    const prompt = buildProtagonistPrompt(seed);
    expect(prompt).toContain("沈奕");
    expect(prompt).toContain("地下拳手");
    expect(prompt).toContain("重情義");
  });

  it("全部留空時，prompt 含「由你自由發揮」提示，且不丟錯", () => {
    const prompt = buildProtagonistPrompt({});
    expect(prompt).toContain("自由發揮");
  });

  it("只有 name 時，其餘欄位走自由發揮提示", () => {
    const prompt = buildProtagonistPrompt({ name: "阿明" });
    expect(prompt).toContain("阿明");
    expect(prompt).toContain("自由發揮");
  });
});
