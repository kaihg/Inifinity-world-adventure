import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { runCharacterPrePass } from "./character-pre-pass.js";
import { formatIntentsBlock } from "./character-pre-pass.js";
import { parseCompanionIds } from "./character-pre-pass.js";
import type { LlmClient } from "../llm/client.js";

function makeClient(response: string): LlmClient {
  return {
    async *streamChat() {
      yield response;
    },
    async chat() {
      return response;
    },
  };
}

async function makeWorld(npcs: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "world-"));
  const charsDir = path.join(dir, "characters");
  await mkdir(charsDir, { recursive: true });
  for (const [id, content] of Object.entries(npcs)) {
    await writeFile(path.join(charsDir, `${id}.md`), content, "utf8");
  }
  return dir;
}

describe("runCharacterPrePass", () => {
  it("有角色檔的 NPC 回傳意圖", async () => {
    const worldDir = await makeWorld({
      yeqing: "# 葉晴\n前特種部隊教官",
    });
    const client = makeClient(
      JSON.stringify({ stance: "觀察", intent: "提出暗號方案", tone: "冷靜" })
    );
    const result = await runCharacterPrePass({
      npcIds: ["yeqing"],
      scene: "安全區大廳",
      playerInput: "測試行動",
      worldDir,
      client,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "yeqing",
      stance: "觀察",
      intent: "提出暗號方案",
      tone: "冷靜",
    });
  });

  it("缺角色檔的 NPC 靜默略過", async () => {
    const worldDir = await makeWorld({});
    const client = makeClient("{}");
    const result = await runCharacterPrePass({
      npcIds: ["ghost"],
      scene: "廢墟",
      playerInput: "行動",
      worldDir,
      client,
    });
    expect(result).toHaveLength(0);
  });

  it("LLM 輸出 JSON 格式錯誤時靜默略過", async () => {
    const worldDir = await makeWorld({ bad: "# Bad NPC" });
    const client = makeClient("不是JSON");
    const result = await runCharacterPrePass({
      npcIds: ["bad"],
      scene: "場景",
      playerInput: "行動",
      worldDir,
      client,
    });
    expect(result).toHaveLength(0);
  });

  it("多個 NPC 並行處理全部回傳", async () => {
    const worldDir = await makeWorld({
      npc1: "# NPC1",
      npc2: "# NPC2",
    });
    const intentJson = JSON.stringify({ stance: "立場", intent: "意圖", tone: "語氣" });
    const client = makeClient(intentJson);
    const result = await runCharacterPrePass({
      npcIds: ["npc1", "npc2"],
      scene: "場景",
      playerInput: "行動",
      worldDir,
      client,
    });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["npc1", "npc2"]);
  });
});

describe("parseCompanionIds", () => {
  const npcs = [
    { id: "yeqing", name: "葉晴" },
    { id: "linsiyu", name: "林思雨" },
    { id: "chenzhe", name: "陳哲" },
  ];

  it("把在場名稱對應成 ID", () => {
    expect(parseCompanionIds("葉晴\n林思雨", npcs)).toEqual(["yeqing", "linsiyu"]);
  });

  it("找不到對應的名稱靜默略過", () => {
    expect(parseCompanionIds("葉晴\n路人甲", npcs)).toEqual(["yeqing"]);
  });

  it("空字串回傳空陣列", () => {
    expect(parseCompanionIds("", npcs)).toEqual([]);
  });

  it("支援 list marker 前綴（- 葉晴）", () => {
    expect(parseCompanionIds("- 葉晴\n- 林思雨", npcs)).toEqual(["yeqing", "linsiyu"]);
  });
});

describe("formatIntentsBlock", () => {
  it("空陣列回傳空字串", () => {
    expect(formatIntentsBlock([], {})).toBe("");
  });

  it("有意圖時回傳格式化區塊", () => {
    const block = formatIntentsBlock(
      [{ id: "yeqing", stance: "觀察", intent: "提暗號方案", tone: "冷靜" }],
      { yeqing: "葉晴" }
    );
    expect(block).toContain("## 在場角色本回合意圖");
    expect(block).toContain("### 葉晴（yeqing）");
    expect(block).toContain("- 立場：觀察");
    expect(block).toContain("- 意圖：提暗號方案");
    expect(block).toContain("- 語氣：冷靜");
  });

  it("缺 npcNames 時用 id 顯示", () => {
    const block = formatIntentsBlock(
      [{ id: "unknown", stance: "s", intent: "i", tone: "t" }],
      {}
    );
    expect(block).toContain("### unknown");
  });
});
