import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ChatMessage, LlmClient } from "../../llm/client.js";
import type { GameState } from "../context.js";
import { runBehaviorLearning, scheduleBehaviorLearning } from "./behavior-learning.js";
import type { TurnDeps } from "./types.js";

function makeState(): GameState {
  return {
    now: {
      chapter: "第一章",
      scene: "安全區",
      companions: "葉晴",
      activeDungeon: "無",
      threads: "",
      nextStep: "觀察",
      lastUpdated: "2026-06-19",
    },
    protagonist: { name: "沈奕", points: "0" },
    protagonistDetail: {
      name: "沈奕",
      points: "0",
      attributes: "力量：中等偏上",
      skills: "",
      items: "",
      buffs: "",
    },
    npcs: [],
    mode: "main-space",
    lastTurn: null,
  };
}

function makeClient(response: string): { client: LlmClient; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    client: {
      async *streamChat(messages: ChatMessage[]) {
        prompts.push(messages.find((m) => m.role === "system")?.content?.toString() ?? "");
        yield response;
      },
    },
  };
}

describe("runBehaviorLearning", () => {
  it("會寫入主角行為檔並 commit", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "iwa-behavior-"));
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    await writeFile(path.join(worldDir, "characters", "protagonist-behavior.md"), "# 舊內容\n", "utf8");

    const cap = makeClient("# 主角行為傾向\n\n## 核心行動偏好\n- 先觀察後行動\n");
    const commits: string[] = [];
    const deps: TurnDeps = {
      client: cap.client,
      worldDir,
      commit: async (msg: string) => {
        commits.push(msg);
        return true;
      },
    };

    await runBehaviorLearning(deps, "世界設定", makeState(), "先退後進", "沈奕先退到掩體再觀察局勢。", { debug() {}, info() {}, warn() {} } as any);

    const file = await readFile(path.join(worldDir, "characters", "protagonist-behavior.md"), "utf8");
    expect(file).toContain("先觀察後行動");
    expect(commits).toEqual(["更新主角行為傾向"]);
    expect(cap.prompts[0]).toContain("主角行為學習器");
  });

  it("輸出與既有內容相同時不 commit", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "iwa-behavior-"));
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    const existing = "# 主角行為傾向\n\n## 核心行動偏好\n- 先觀察後行動\n";
    await writeFile(path.join(worldDir, "characters", "protagonist-behavior.md"), existing, "utf8");

    const deps: TurnDeps = {
      client: {
        async *streamChat() {
          yield existing;
        },
      },
      worldDir,
      commit: async () => {
        throw new Error("不該 commit");
      },
    };

    await runBehaviorLearning(deps, "世界設定", makeState(), "先退後進", "沈奕先退到掩體再觀察局勢。", { debug() {}, info() {}, warn() {} } as any);
    const file = await readFile(path.join(worldDir, "characters", "protagonist-behavior.md"), "utf8");
    expect(file).toBe(existing);
  });
});

describe("scheduleBehaviorLearning", () => {
  it("有 pending handle 時會串接到既有 promise 之後", async () => {
    const worldDir = await mkdtemp(path.join(os.tmpdir(), "iwa-behavior-"));
    await mkdir(path.join(worldDir, "characters"), { recursive: true });
    await writeFile(path.join(worldDir, "characters", "protagonist-behavior.md"), "# 舊內容\n", "utf8");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const deps: TurnDeps = {
      client: {
        async *streamChat() {
          order.push("behavior-start");
          yield "# 主角行為傾向\n\n## 核心行動偏好\n- 先觀察後行動\n";
          order.push("behavior-end");
        },
      },
      worldDir,
      commit: async () => true,
      pendingLoreSync: {
        promise: gate.then(() => {
          order.push("lore-done");
        }),
      },
    };

    const scheduled = scheduleBehaviorLearning(deps, "世界設定", makeState(), "先退後進", "沈奕先退到掩體再觀察局勢。", { debug() {}, info() {}, warn() {} } as any);
    order.push("scheduled");
    release();
    await scheduled;
    await deps.pendingLoreSync?.promise;

    expect(order).toEqual(["scheduled", "lore-done", "behavior-start", "behavior-end"]);
  });
});
