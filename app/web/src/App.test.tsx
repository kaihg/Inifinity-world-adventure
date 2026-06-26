import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field, shouldTypewriterOutput } from "./App";

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
