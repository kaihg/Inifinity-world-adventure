import { describe, it, expect } from "vitest";
import { parseFastControlOutput, parseLoreSyncOutput } from "./schema.js";

const VALID = `{
  "state_changes": { "now": { "scene": "資訊室", "nextStep": "找葉晴談戰術" }, "protagonist_points_delta": 0 },
  "rolls": [],
  "mode_transition": null,
  "awaiting_user_input": true,
  "suggested_actions": ["找葉晴", "回休息區"],
  "commit_summary": "沈奕前往資訊室"
}`;

describe("parseFastControlOutput（Layer 2：only now/protagonist/rolls/mode_transition/awaiting/suggested/commit）", () => {
  it("解析整段 JSON 並通過 schema 驗證", () => {
    const control = parseFastControlOutput(VALID);
    expect(control.awaiting_user_input).toBe(true);
    expect(control.suggested_actions).toEqual(["找葉晴", "回休息區"]);
    expect(control.commit_summary).toBe("沈奕前往資訊室");
    expect(control.state_changes.now?.scene).toBe("資訊室");
    expect(control.mode_transition).toBeNull();
  });

  it("容忍 JSON 前後有雜訊文字（抓第一個 { 到最後一個 }）", () => {
    const control = parseFastControlOutput(
      '這是控制區塊：\n{"awaiting_user_input":false,"commit_summary":"x"}\n以上。',
    );
    expect(control.awaiting_user_input).toBe(false);
    expect(control.commit_summary).toBe("x");
  });

  it("合法 JSON 之後跟了含 } 的客套字時，仍能還原（不誤抓後綴的 }）", () => {
    const control = parseFastControlOutput(
      '{"awaiting_user_input":true,"commit_summary":"沈奕前進"}\n備註：詳見附錄 {A}。',
    );
    expect(control.awaiting_user_input).toBe(true);
    expect(control.commit_summary).toBe("沈奕前進");
  });

  it("容忍 markdown code fence 包住 JSON", () => {
    const control = parseFastControlOutput(
      '```json\n{"awaiting_user_input":false,"commit_summary":"x"}\n```',
    );
    expect(control.awaiting_user_input).toBe(false);
    expect(control.commit_summary).toBe("x");
  });

  it("找不到 JSON 物件時拋錯", () => {
    expect(() => parseFastControlOutput("完全沒有大括號")).toThrow();
  });

  it("JSON 非法時拋錯", () => {
    expect(() => parseFastControlOutput("{not json}")).toThrow();
  });

  it("缺必要欄位 awaiting_user_input 時拋錯", () => {
    expect(() => parseFastControlOutput('{"commit_summary":"x"}')).toThrow();
  });

  it("Layer 2 不再接受 protagonist_updates（已移至 Layer 3）", () => {
    const raw = JSON.stringify({
      state_changes: { protagonist_updates: { skills: ["近戰格鬥精通"], items: ["生鏽鐵管"] } },
      awaiting_user_input: true,
      commit_summary: "x",
    });
    const control = parseFastControlOutput(raw);
    // protagonist_updates 不再是 Layer 2 schema 的欄位，zod 會忽略它
    expect(control.state_changes.protagonist_updates).toBeUndefined();
  });

  it("修復無引號的鍵後仍能解析", () => {
    const control = parseFastControlOutput(
      '{ awaiting_user_input: false, commit_summary: "沈奕離開資訊室" }',
    );
    expect(control.awaiting_user_input).toBe(false);
    expect(control.commit_summary).toBe("沈奕離開資訊室");
  });

  it("修復單引號的鍵後仍能解析", () => {
    const control = parseFastControlOutput(
      '{ \'awaiting_user_input\': true, \'commit_summary\': "沈奕進入副本" }',
    );
    expect(control.awaiting_user_input).toBe(true);
    expect(control.commit_summary).toBe("沈奕進入副本");
  });

  it("字串值裡含有逗號接冒號的敘事文字時，合法 JSON 仍能直接解析（不誤觸鍵修復）", () => {
    const control = parseFastControlOutput(
      JSON.stringify({
        awaiting_user_input: true,
        commit_summary: "查看地圖, time: 5pm 抵達",
      }),
    );
    expect(control.commit_summary).toBe("查看地圖, time: 5pm 抵達");
  });
});

describe("parseLoreSyncOutput（Layer 3：touched_entities + dungeon_wiki_excerpt，不需 awaiting/commit）", () => {
  it("接受 touched_entities（npc/item/location/skill）與 dungeon_wiki_excerpt", () => {
    const raw = JSON.stringify({
      state_changes: {
        touched_entities: [
          { id: "ye-qing", category: "npc", name: "葉晴", excerpt: "葉晴的信任又提升了一點。" },
          { id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "撿到一根生鏽鐵管。" },
          { id: "info-room", category: "location", name: "資訊室", excerpt: "資訊室牆上有監視器。" },
          { id: "melee-mastery", category: "skill", name: "近戰格鬥精通", excerpt: "領悟了近戰格鬥精通。" },
        ],
        dungeon_wiki_excerpt: "資訊室牆上有監視器",
      },
    });
    const sync = parseLoreSyncOutput(raw);
    expect(sync.state_changes.touched_entities).toEqual([
      { id: "ye-qing", category: "npc", name: "葉晴", excerpt: "葉晴的信任又提升了一點。" },
      { id: "rusty-pipe", category: "item", name: "生鏽鐵管", excerpt: "撿到一根生鏽鐵管。" },
      { id: "info-room", category: "location", name: "資訊室", excerpt: "資訊室牆上有監視器。" },
      { id: "melee-mastery", category: "skill", name: "近戰格鬥精通", excerpt: "領悟了近戰格鬥精通。" },
    ]);
    expect(sync.state_changes.dungeon_wiki_excerpt).toBe("資訊室牆上有監視器");
  });

  it("category 不在 npc/item/location/skill 之中時拋錯", () => {
    const raw = JSON.stringify({
      state_changes: {
        touched_entities: [{ id: "x", category: "monster", name: "x", excerpt: "x" }],
      },
    });
    expect(() => parseLoreSyncOutput(raw)).toThrow();
  });

  it("空物件也能解析（本回合沒有任何 lore 異動）", () => {
    const sync = parseLoreSyncOutput("{}");
    // protagonist_changed 預設為 false
    expect(sync.state_changes.protagonist_changed).toBe(false);
    expect(sync.state_changes.touched_entities).toBeUndefined();
    expect(sync.state_changes.dungeon_wiki_excerpt).toBeUndefined();
  });

  it("找不到 JSON 物件時拋錯", () => {
    expect(() => parseLoreSyncOutput("完全沒有大括號")).toThrow();
  });
});

describe("protagonist_permanent_death 欄位", () => {
  it("省略時預設為 false", () => {
    const control = parseFastControlOutput(
      '{"awaiting_user_input":true,"commit_summary":"x"}',
    );
    expect(control.protagonist_permanent_death).toBe(false);
  });

  it("顯式 true 被保留", () => {
    const control = parseFastControlOutput(
      '{"awaiting_user_input":true,"commit_summary":"x","protagonist_permanent_death":true}',
    );
    expect(control.protagonist_permanent_death).toBe(true);
  });

  it("顯式 false 被保留", () => {
    const control = parseFastControlOutput(
      '{"awaiting_user_input":true,"commit_summary":"x","protagonist_permanent_death":false}',
    );
    expect(control.protagonist_permanent_death).toBe(false);
  });
});

describe("Layer 權責重劃：protagonist 欄位移到 Layer 3", () => {
  it("FastControl 解析時忽略殘留的 protagonist_points_delta（不再是 schema 欄位）", () => {
    const control = parseFastControlOutput(
      JSON.stringify({
        state_changes: { now: { scene: "資訊室" }, protagonist_points_delta: 5 },
        awaiting_user_input: true,
        commit_summary: "x",
      }),
    );
    // 欄位已從 FastStateChangesSchema 移除：解析不應再暴露它
    expect((control.state_changes as Record<string, unknown>).protagonist_points_delta).toBeUndefined();
    expect((control.state_changes as Record<string, unknown>).protagonist_updates).toBeUndefined();
    expect(control.state_changes.now?.scene).toBe("資訊室");
  });

  it("LoreSync 解析 protagonist_points_delta 與 protagonist_changed", () => {
    const sync = parseLoreSyncOutput(
      JSON.stringify({
        state_changes: { protagonist_points_delta: 3, protagonist_changed: true },
      }),
    );
    expect(sync.state_changes.protagonist_points_delta).toBe(3);
    expect(sync.state_changes.protagonist_changed).toBe(true);
  });

  it("LoreSync 的 protagonist_changed 缺省時為 false", () => {
    const sync = parseLoreSyncOutput(JSON.stringify({ state_changes: {} }));
    expect(sync.state_changes.protagonist_changed).toBe(false);
    expect(sync.state_changes.protagonist_points_delta).toBeUndefined();
  });
});
