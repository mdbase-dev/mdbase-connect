import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuickOpen, ShortcutHelp } from "./QuickOpen";

describe("keyboard discovery", () => {
  it.each(["MacIntel", "iPad", "Linux x86_64"])("shows one quick-open chord and link-only K on %s", (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    render(<ShortcutHelp onClose={() => {}} />);
    const modifier = platform === "Linux x86_64" ? "Ctrl" : "⌘";
    expect(screen.getByText(`${modifier} P`, { selector: "kbd" })).toBeInTheDocument();
    expect(screen.getAllByText(`${modifier} K`, { selector: "kbd" })).toHaveLength(1);
    expect(screen.getByText("Add a link, in the note text")).toBeInTheDocument();
    expect(screen.queryByText("Quick open, outside the note text")).not.toBeInTheDocument();
  });

  it("opens command mode directly, fuzzy matches actions and displays shortcut chips", () => {
    const run = vi.fn(), close = vi.fn();
    render(<QuickOpen index={[]} recentPaths={[]} types={[]} initialCommandMode commands={[{ id: "focus", label: "Focus mode", shortcut: "Mod Shift F", run }, { id: "copy-path", label: "Copy path", run }]} onSelect={() => {}} onClose={close} />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveValue(">");
    expect(screen.getByText(/Shift F/, { selector: "kbd" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: ">fcs md" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(localStorage.getItem("mdbase-editor:recent-commands")).toContain("focus");
  });

  it("keeps keyboard selection visible and never selects -1 on empty results", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const run = vi.fn();
    const commands = Array.from({ length: 20 }, (_, index) => ({ id: `${index}`, label: `Action ${index}`, run }));
    render(<QuickOpen index={[]} recentPaths={[]} types={[]} commands={commands} onSelect={() => {}} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "End" });
    expect(input).toHaveAttribute("aria-activedescendant", "quick-open-19");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    fireEvent.change(input, { target: { value: ">missing" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.change(input, { target: { value: ">Action 0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });
});
