import { describe, it, expect } from "vitest";
import { parseTurnOutput } from "./schema.js";

const VALID = `沈奕環顧四周，安全區一切如常。
===STATE===
{
  "state_changes": { "now": { "scene": "資訊室", "nextStep": "找葉晴談戰術" }, "protagonist_points_delta": 0 },
  "awaiting_user_input": true,
  "suggested_actions": ["找葉晴", "回休息區"],
  "commit_summary": "沈奕前往資訊室"
}`;

describe("parseTurnOutput", () => {
  it("拆出敘事與控制區塊並通過 schema 驗證", () => {
    const { narrative, control } = parseTurnOutput(VALID);
    expect(narrative).toBe("沈奕環顧四周，安全區一切如常。");
    expect(control.awaiting_user_input).toBe(true);
    expect(control.suggested_actions).toEqual(["找葉晴", "回休息區"]);
    expect(control.commit_summary).toBe("沈奕前往資訊室");
    expect(control.state_changes.now?.scene).toBe("資訊室");
    expect(control.mode_transition).toBeNull();
  });

  it("缺 sentinel 時拋錯", () => {
    expect(() => parseTurnOutput("只有敘事沒有控制")).toThrow();
  });

  it("JSON 非法時拋錯", () => {
    expect(() => parseTurnOutput("敘事\n===STATE===\n{not json}")).toThrow();
  });

  it("缺必要欄位 awaiting_user_input 時拋錯", () => {
    expect(() =>
      parseTurnOutput('敘事\n===STATE===\n{"commit_summary":"x"}'),
    ).toThrow();
  });
});
