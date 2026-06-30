import { describe, it, expect } from "vitest";
import { runRecallBlock } from "./context-blocks.js";
import type { TurnDeps } from "./types.js";

function makeDeps(queryCapture: { value: string }): Partial<TurnDeps> {
  return {
    recall: {
      query: async (q: string) => {
        queryCapture.value = q;
        return [];
      },
      upsertFile: async () => {},
    } as unknown as TurnDeps["recall"],
    recallTopK: 3,
  };
}

describe("runRecallBlock", () => {
  it("無 recall 時回空字串", async () => {
    const gen = runRecallBlock({ recall: undefined } as unknown as TurnDeps, "行動");
    const result = await gen.next();
    expect(result.value).toBe("");
  });

  it("有 lastNarrative 時查詢源為 lastNarrative + input 的組合", async () => {
    const capture = { value: "" };
    const deps = makeDeps(capture);
    const gen = runRecallBlock(
      deps as unknown as TurnDeps,
      "我向前走",
      "林逸站在主神空間中央，幾何晶體緩緩旋轉。",
    );
    // drain generator
    let done = false;
    while (!done) { done = (await gen.next()).done ?? false; }
    expect(capture.value).toContain("林逸站在主神空間");
    expect(capture.value).toContain("我向前走");
  });

  it("無 lastNarrative 時查詢源僅為 input", async () => {
    const capture = { value: "" };
    const deps = makeDeps(capture);
    const gen = runRecallBlock(deps as unknown as TurnDeps, "我向前走");
    let done = false;
    while (!done) { done = (await gen.next()).done ?? false; }
    expect(capture.value).toBe("我向前走");
  });
});
