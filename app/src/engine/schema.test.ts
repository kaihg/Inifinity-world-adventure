import { describe, it, expect } from "vitest";
import { parseControlOutput } from "./schema.js";

const VALID = `{
  "state_changes": { "now": { "scene": "資訊室", "nextStep": "找葉晴談戰術" }, "protagonist_points_delta": 0 },
  "rolls": [],
  "mode_transition": null,
  "awaiting_user_input": true,
  "suggested_actions": ["找葉晴", "回休息區"],
  "commit_summary": "沈奕前往資訊室"
}`;

describe("parseControlOutput", () => {
  it("解析整段 JSON 並通過 schema 驗證", () => {
    const control = parseControlOutput(VALID);
    expect(control.awaiting_user_input).toBe(true);
    expect(control.suggested_actions).toEqual(["找葉晴", "回休息區"]);
    expect(control.commit_summary).toBe("沈奕前往資訊室");
    expect(control.state_changes.now?.scene).toBe("資訊室");
    expect(control.mode_transition).toBeNull();
  });

  it("容忍 JSON 前後有雜訊文字（抓第一個 { 到最後一個 }）", () => {
    const control = parseControlOutput(
      '這是控制區塊：\n{"awaiting_user_input":false,"commit_summary":"x"}\n以上。',
    );
    expect(control.awaiting_user_input).toBe(false);
    expect(control.commit_summary).toBe("x");
  });

  it("找不到 JSON 物件時拋錯", () => {
    expect(() => parseControlOutput("完全沒有大括號")).toThrow();
  });

  it("JSON 非法時拋錯", () => {
    expect(() => parseControlOutput("{not json}")).toThrow();
  });

  it("缺必要欄位 awaiting_user_input 時拋錯", () => {
    expect(() => parseControlOutput('{"commit_summary":"x"}')).toThrow();
  });

  it("接受 protagonist_updates 子欄位", () => {
    const raw = JSON.stringify({
      state_changes: { protagonist_updates: { skills: ["近戰格鬥精通"], items: ["生鏽鐵管"] } },
      awaiting_user_input: true,
      commit_summary: "x",
    });
    const control = parseControlOutput(raw);
    expect(control.state_changes.protagonist_updates?.skills).toEqual(["近戰格鬥精通"]);
    expect(control.state_changes.protagonist_updates?.items).toEqual(["生鏽鐵管"]);
  });

  it("接受 item_pickups / item_reveals 子欄位", () => {
    const raw = JSON.stringify({
      state_changes: {
        item_pickups: [{ id: "rusty-pipe", name: "生鏽鐵管" }],
        item_reveals: [{ id: "rusty-pipe", reveal: "管身刻有奇怪符號" }],
      },
      awaiting_user_input: true,
      commit_summary: "x",
    });
    const control = parseControlOutput(raw);
    expect(control.state_changes.item_pickups).toEqual([{ id: "rusty-pipe", name: "生鏽鐵管" }]);
    expect(control.state_changes.item_reveals).toEqual([{ id: "rusty-pipe", reveal: "管身刻有奇怪符號" }]);
  });
});
