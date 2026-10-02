import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionMenu } from "./ActionMenu";

describe("ActionMenu groups", () => {
  it("renders accessible separators without making them keyboard stops", async () => {
    const select = vi.fn();
    render(<ActionMenu label="More note actions" items={[
      { label: "Rename", icon: null, onSelect: vi.fn() },
      { label: "Document outline", icon: null, separatorBefore: true, onSelect: select },
      { label: "Attach file…", icon: null, separatorBefore: true, disabled: true, onSelect: vi.fn() },
      { label: "Keyboard shortcuts", icon: null, separatorBefore: true, onSelect: vi.fn() }
    ]} />);
    const trigger = screen.getByRole("button", { name: "More note actions" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(screen.getAllByRole("separator")).toHaveLength(3);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Document outline" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Keyboard shortcuts" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Document outline" }));
    expect(select).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
