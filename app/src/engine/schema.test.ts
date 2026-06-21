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

  it("合法 JSON 之後跟了含 } 的客套字時，仍能還原（不誤抓後綴的 }）", () => {
    const control = parseControlOutput(
      '{"awaiting_user_input":true,"commit_summary":"沈奕前進"}\n備註：詳見附錄 {A}。',
    );
    expect(control.awaiting_user_input).toBe(true);
    expect(control.commit_summary).toBe("沈奕前進");
  });

  it("容忍 markdown code fence 包住 JSON", () => {
    const control = parseControlOutput(
      '```json\n{"awaiting_user_input":false,"commit_summary":"x"}\n```',
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

  it("修復無引號的鍵後仍能解析", () => {
    const control = parseControlOutput(
      '{ awaiting_user_input: false, commit_summary: "沈奕離開資訊室" }',
    );
    expect(control.awaiting_user_input).toBe(false);
    expect(control.commit_summary).toBe("沈奕離開資訊室");
  });

  it("修復單引號的鍵後仍能解析", () => {
    const control = parseControlOutput(
      '{ \'awaiting_user_input\': true, \'commit_summary\': "沈奕進入副本" }',
    );
    expect(control.awaiting_user_input).toBe(true);
    expect(control.commit_summary).toBe("沈奕進入副本");
  });

  it("字串值裡含有逗號接冒號的敘事文字時，合法 JSON 仍能直接解析（不誤觸鍵修復）", () => {
    const control = parseControlOutput(
      JSON.stringify({
        awaiting_user_input: true,
        commit_summary: "查看地圖, time: 5pm 抵達",
      }),
    );
    expect(control.commit_summary).toBe("查看地圖, time: 5pm 抵達");
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

  it("接受 location_pickups / location_reveals / skill_pickups / skill_reveals 子欄位", () => {
    const raw = JSON.stringify({
      state_changes: {
        location_pickups: [{ id: "info-room", name: "資訊室" }],
        location_reveals: [{ id: "info-room", reveal: "牆上有一面鏡子" }],
        skill_pickups: [{ id: "melee-mastery", name: "近戰格鬥精通" }],
        skill_reveals: [{ id: "melee-mastery", reveal: "疊滿三層後解鎖突進" }],
      },
      awaiting_user_input: true,
      commit_summary: "x",
    });
    const control = parseControlOutput(raw);
    expect(control.state_changes.location_pickups).toEqual([{ id: "info-room", name: "資訊室" }]);
    expect(control.state_changes.location_reveals).toEqual([{ id: "info-room", reveal: "牆上有一面鏡子" }]);
    expect(control.state_changes.skill_pickups).toEqual([{ id: "melee-mastery", name: "近戰格鬥精通" }]);
    expect(control.state_changes.skill_reveals).toEqual([{ id: "melee-mastery", reveal: "疊滿三層後解鎖突進" }]);
  });
});
