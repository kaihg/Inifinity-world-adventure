import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "./App";

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
