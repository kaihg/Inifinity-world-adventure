import { describe, it, expect, vi, afterEach } from "vitest";
import { pollUntilProgressed, type GameState } from "./api";

function makeState(lastUpdated: string, withLastTurn = true): GameState {
  return {
    now: { chapter: "c", scene: "s", companions: "", activeDungeon: "", threads: "", nextStep: "", lastUpdated },
    protagonist: { name: "x", points: "0" },
    protagonistDetail: { name: "x", points: "0", attributes: "", skills: "", items: "", buffs: "" },
    npcs: [],
    mode: "main-space",
    lastTurn: withLastTurn ? { narrative: "敘事", suggestedActions: ["行動"] } : null,
  };
}

describe("pollUntilProgressed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("第一次輪詢偵測到 lastUpdated 推進時立即回傳最新 state", async () => {
    const newState = makeState("T2");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => newState }));

    const result = await pollUntilProgressed("T1", { maxAttempts: 3, intervalMs: 0 });

    expect(result).toBe(newState);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("lastUpdated 未推進時輪詢 maxAttempts 次後回傳 null", async () => {
    const sameState = makeState("T1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => sameState }));

    const result = await pollUntilProgressed("T1", { maxAttempts: 3, intervalMs: 0 });

    expect(result).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("fetchState 拋錯時靜默繼續，全部失敗後回傳 null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await pollUntilProgressed("T1", { maxAttempts: 3, intervalMs: 0 });

    expect(result).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("preTurnLastUpdated 為 undefined 時即使 lastUpdated 有新值也回傳 null", async () => {
    const newState = makeState("T2");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => newState }));

    const result = await pollUntilProgressed(undefined, { maxAttempts: 2, intervalMs: 0 });

    expect(result).toBeNull();
  });

  it("lastTurn 為 null 時不視為癒合成功", async () => {
    const noLastTurn = makeState("T2", false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => noLastTurn }));

    const result = await pollUntilProgressed("T1", { maxAttempts: 2, intervalMs: 0 });

    expect(result).toBeNull();
  });

  it("第二次才成功時回傳正確 state（前幾次未推進不影響後續）", async () => {
    const sameState = makeState("T1");
    const newState = makeState("T2");
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      calls++;
      return { ok: true, json: async () => (calls < 2 ? sameState : newState) };
    }));

    const result = await pollUntilProgressed("T1", { maxAttempts: 3, intervalMs: 0 });

    expect(result).toBe(newState);
    expect(calls).toBe(2);
  });
});
