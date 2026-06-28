import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App, Field, makeTurnEventHandler } from "./App";

// vi.mock is hoisted — applies to all tests in this file
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchWorldStatus: vi.fn().mockResolvedValue({ initialized: false }),
    fetchState: vi.fn().mockResolvedValue({
      now: { chapter: "", scene: "", companions: "", activeDungeon: "", threads: "", nextStep: "", lastUpdated: "" },
      protagonist: { name: "測試者", points: "1000" },
      protagonistDetail: { name: "測試者", points: "1000", attributes: "", skills: "", items: "", buffs: "" },
      npcs: [],
      mode: "main-space",
      lastTurn: null,
    }),
    fetchVersion: vi.fn().mockResolvedValue({ hash: "abc", message: "test" }),
    fetchConfig: vi.fn().mockResolvedValue({ typewriterIntervalMs: 50 }),
    fetchTurnStatus: vi.fn().mockResolvedValue({ active: false, turnId: null }),
    initWorld: vi.fn().mockResolvedValue({
      now: { chapter: "第一章", scene: "主神空間", companions: "（無）", activeDungeon: "無", threads: "無", nextStep: "", lastUpdated: "[2026-06-27] 進入主神空間" },
      protagonist: { name: "測試者", points: "1000" },
      protagonistDetail: { name: "測試者", points: "1000", attributes: "", skills: "", items: "", buffs: "" },
      npcs: [],
      mode: "main-space",
      lastTurn: null,
    }),
    streamTurn: vi.fn().mockImplementation(async (_input: string, onEvent: (ev: any) => void) => {
      onEvent({ type: "delta", text: "開場敘事..." });
      onEvent({ type: "done", narrative: "開場敘事...", committed: true, awaitingUserInput: true, suggestedActions: ["觀察四周"], modeTransition: null, protagonistDied: false });
    }),
  };
});

describe("Field", () => {
  it("renders markdown lists and bold text instead of raw syntax", () => {
    render(<Field label="屬性" value={"- **力量**: 10\n- **敏捷**: 8"} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("力量: 10");
    expect(items[0].querySelector("strong")).toHaveTextContent("力量");
    expect(items[1]).toHaveTextContent("敏捷: 8");
    expect(screen.queryByText(/-\s*\*\*/)).not.toBeInTheDocument();
  });

  it("shows em dash placeholder when value is empty", () => {
    render(<Field label="屬性" value="" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});


describe("makeTurnEventHandler", () => {
  function makeDeps(overrides: Partial<Parameters<typeof makeTurnEventHandler>[0]> = {}) {
    return {
      enqueue: vi.fn(),
      startTypewriter: vi.fn(),
      stopTypewriter: vi.fn(),
      appendStory: vi.fn(),
      setSuggested: vi.fn(),
      setState: vi.fn(),
      setProtagonistDied: vi.fn(),
      setLlmDone: vi.fn(),
      ...overrides,
    };
  }

  it("delta: 逐字 enqueue 並啟動 typewriter", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    handler({ type: "delta", text: "ab" });
    expect(deps.enqueue).toHaveBeenNthCalledWith(1, "a");
    expect(deps.enqueue).toHaveBeenNthCalledWith(2, "b");
    expect(deps.startTypewriter).toHaveBeenCalledOnce();
  });

  it("transition 進副本：append 轉場訊息並清空 suggestedActions", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    handler({ type: "transition", to: "dungeon", dungeonId: "forest-001" });
    expect(deps.appendStory).toHaveBeenCalledWith(expect.stringContaining("進入副本 forest-001"));
    expect(deps.setSuggested).toHaveBeenCalledWith([]);
  });

  it("transition 返回主空間：append 返回訊息", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    handler({ type: "transition", to: "main-space" });
    expect(deps.appendStory).toHaveBeenCalledWith(expect.stringContaining("返回安全區"));
  });

  it("warning: append 提示訊息", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    handler({ type: "warning", message: "危險警示" });
    expect(deps.appendStory).toHaveBeenCalledWith(expect.stringContaining("[提示] 危險警示"));
  });

  it("error: 停止 typewriter 並 append 錯誤訊息", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    handler({ type: "error", message: "連線中斷" });
    expect(deps.stopTypewriter).toHaveBeenCalledWith(true);
    expect(deps.appendStory).toHaveBeenCalledWith(expect.stringContaining("[錯誤] 連線中斷"));
  });

  it("done protagonistDied=true：標記死亡並清空 suggested", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    const baseDone = { type: "done" as const, narrative: "", committed: true, modeTransition: null, transitionDungeonId: undefined, transitionDungeonGoal: undefined };
    handler({ ...baseDone, awaitingUserInput: false, suggestedActions: [], protagonistDied: true });
    expect(deps.setProtagonistDied).toHaveBeenCalledWith(true);
    expect(deps.setSuggested).toHaveBeenCalledWith([]);
    expect(deps.setLlmDone).toHaveBeenCalled();
  });

  it("done awaitingUserInput=true：帶入 suggestedActions", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    const baseDone = { type: "done" as const, narrative: "", committed: true, modeTransition: null, protagonistDied: false };
    handler({ ...baseDone, awaitingUserInput: true, suggestedActions: ["行動A", "行動B"] });
    expect(deps.setSuggested).toHaveBeenCalledWith(["行動A", "行動B"]);
    expect(deps.setLlmDone).toHaveBeenCalled();
  });

  it("done awaitingUserInput=false：清空 suggested", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    const baseDone = { type: "done" as const, narrative: "", committed: true, modeTransition: null, protagonistDied: false };
    handler({ ...baseDone, awaitingUserInput: false, suggestedActions: [] });
    expect(deps.setSuggested).toHaveBeenCalledWith([]);
    expect(deps.setLlmDone).toHaveBeenCalled();
  });

  it("done 有 state：呼叫 setState", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    const fakeState = { now: { lastUpdated: "t" } } as never;
    const baseDone = { type: "done" as const, narrative: "", committed: true, modeTransition: null, protagonistDied: false };
    handler({ ...baseDone, awaitingUserInput: false, suggestedActions: [], state: fakeState });
    expect(deps.setState).toHaveBeenCalledWith(fakeState);
  });

  it("ping：靜默忽略，不呼叫任何 dep", () => {
    const deps = makeDeps();
    const handler = makeTurnEventHandler(deps);
    handler({ type: "ping" });
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.appendStory).not.toHaveBeenCalled();
    expect(deps.setLlmDone).not.toHaveBeenCalled();
  });
});

describe("post-init opening turn", () => {
  it("initWorld 完成後自動觸發 streamTurn 且顯示 opening 敘事", async () => {
    const { streamTurn } = await import("./api");

    render(<App />);

    // 等 WorldSetupWizard 出現
    await screen.findByText("建立世界");

    // 點「建立世界」按鈕
    const btn = screen.getByRole("button", { name: "建立世界" });
    await userEvent.click(btn);

    // 等 streamTurn 被呼叫（opening turn 自動觸發）
    await waitFor(() => {
      expect(streamTurn).toHaveBeenCalledWith("", expect.any(Function));
    });
  });
});
