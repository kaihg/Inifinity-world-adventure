import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App, Field, shouldTypewriterOutput } from "./App";

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

describe("shouldTypewriterOutput", () => {
  it("queue 充足時回 true", () => {
    expect(shouldTypewriterOutput({ queueLength: 25, llmDone: false })).toBe(true);
  });

  it("queue 不足且 LLM 未完成時回 false（lookahead pause）", () => {
    expect(shouldTypewriterOutput({ queueLength: 5, llmDone: false })).toBe(false);
  });

  it("LLM 完成後即使 queue 不足也回 true（排空 queue）", () => {
    expect(shouldTypewriterOutput({ queueLength: 5, llmDone: true })).toBe(true);
  });

  it("queue 為 0 且 LLM 完成 → 回 false（沒字可取）", () => {
    expect(shouldTypewriterOutput({ queueLength: 0, llmDone: true })).toBe(false);
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
