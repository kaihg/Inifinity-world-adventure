import { describe, it, expect } from "vitest";
import { traditionalizeFastControl } from "./turn-core.js";
import type { FastControl } from "../schema.js";

function baseControl(overrides: Partial<FastControl> = {}): FastControl {
  return {
    state_changes: {},
    rolls: [],
    mode_transition: null,
    awaiting_user_input: true,
    protagonist_permanent_death: false,
    suggested_actions: [],
    commit_summary: "回合摘要",
    ...overrides,
  };
}

describe("traditionalizeFastControl", () => {
  it("繁體化 commit_summary / suggested_actions / rolls.desc", () => {
    const out = traditionalizeFastControl(
      baseControl({
        commit_summary: "叶晴确认触发机制",
        suggested_actions: ["继续观察", "检查装备"],
        rolls: [{ desc: "格斗命中", value: 50, success: true }],
      }),
    );
    expect(out.commit_summary).toBe("葉晴確認觸發機制");
    expect(out.suggested_actions).toEqual(["繼續觀察", "檢查裝備"]);
    expect(out.rolls[0].desc).toBe("格鬥命中");
    expect(out.rolls[0].value).toBe(50); // 非字串欄位不動
  });

  it("繁體化 now 各欄與 protagonist_updates 各項", () => {
    const out = traditionalizeFastControl(
      baseControl({
        state_changes: {
          now: { scene: "安全区休息区", nextStep: "继续准备" },
          protagonist_updates: { items: ["简易急救包"], attributes: ["敏捷提升"] },
        },
      }),
    );
    expect(out.state_changes.now?.scene).toBe("安全區休息區");
    expect(out.state_changes.now?.nextStep).toBe("繼續準備");
    expect(out.state_changes.protagonist_updates?.items).toEqual(["簡易急救包"]);
    expect(out.state_changes.protagonist_updates?.attributes).toEqual(["敏捷提升"]);
  });

  it("不繁體化 transition_dungeon_id（slug 保留原樣）", () => {
    const out = traditionalizeFastControl(
      baseControl({ mode_transition: "enter_dungeon", transition_dungeon_id: "broken-city" }),
    );
    expect(out.transition_dungeon_id).toBe("broken-city");
  });

  it("不可變更新：不動原物件", () => {
    const input = baseControl({ commit_summary: "触发" });
    const out = traditionalizeFastControl(input);
    expect(input.commit_summary).toBe("触发"); // 原物件未被改動
    expect(out).not.toBe(input);
  });

  it("now / protagonist_updates 缺省時不報錯", () => {
    const out = traditionalizeFastControl(baseControl());
    expect(out.state_changes.now).toBeUndefined();
    expect(out.state_changes.protagonist_updates).toBeUndefined();
  });
});
