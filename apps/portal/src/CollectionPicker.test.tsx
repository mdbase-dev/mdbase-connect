import { useState, type ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CollectionPicker } from "./CollectionPicker";

const choices = [{ id: "beta", name: "Beta notes", hint: "Shared with you" }, { id: "alpha", name: "Alpha", hint: "Owner" }, { id: "zeta", name: "Zeta" }];
function show(extra: Partial<ComponentProps<typeof CollectionPicker>> = {}) {
  const change = vi.fn();
  function Fixture() {
    const [value, setValue] = useState(extra.value ?? "");
    return <CollectionPicker label="Open in TaskNotes" collections={choices} {...extra} value={value} onChoose={id => { change(id); setValue(id); }} />;
  }
  const view = render(<Fixture />);
  return { ...view, change, input: screen.getByRole("combobox", { name: "Open in TaskNotes" }), list: screen.getByRole("listbox", { name: "Open in TaskNotes" }) };
}

describe("manual collection consent combobox", () => {
  it("never preselects, even with one collection and a remembered preference", () => {
    localStorage.setItem(`mdbase-connect:last-collection:${location.origin}`, "alpha");
    const f = show({ collections: [choices[1]!] });
    expect(f.container.querySelector("select")).toBeNull();
    expect(screen.queryAllByRole("option", { selected: true })).toEqual([]);
    expect(f.input).not.toHaveAttribute("aria-activedescendant");
    expect(f.input).toHaveAttribute("data-value", "");
    expect(f.change).not.toHaveBeenCalled();
  });
  it("sorts the known recently used collection first, then names alphabetically, with owner/shared descriptions", () => {
    localStorage.setItem(`mdbase-connect:last-collection:${location.origin}`, "beta");
    const f = show();
    expect(within(f.list).getAllByRole("option").map(option => option.getAttribute("aria-label"))).toEqual(["Beta notes", "Alpha", "Zeta"]);
    expect(screen.getByRole("option", { name: "Beta notes" })).toHaveAccessibleDescription("Recently used · Shared with you");
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveAccessibleDescription("Owner");
    expect(screen.queryAllByRole("option", { selected: true })).toEqual([]);
  });
  it("filters 150+ names live by case-insensitive substring, never selecting from typing or bare Enter", () => {
    const collections = Array.from({ length: 160 }, (_, i) => ({ id: `notes-${i}`, name: `Notes ${i}` }));
    const f = show({ collections });
    expect(within(f.list).getAllByRole("option")).toHaveLength(160);
    fireEvent.change(f.input, { target: { value: "nOtEs 159" } });
    expect(within(f.list).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "Notes 159" })).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(f.input, { key: "Enter" });
    expect(f.change).not.toHaveBeenCalled();
  });
  it("arrows only highlight; Enter commits exactly the highlighted row without submitting a form", () => {
    const f = show();
    fireEvent.keyDown(f.input, { key: "ArrowDown" });
    expect(document.getElementById(f.input.getAttribute("aria-activedescendant")!)).toHaveAttribute("aria-label", "Alpha");
    fireEvent.keyDown(f.input, { key: "ArrowDown" });
    expect(document.getElementById(f.input.getAttribute("aria-activedescendant")!)).toHaveAttribute("aria-label", "Beta notes");
    expect(f.change).not.toHaveBeenCalled();
    expect(f.input).toHaveAttribute("data-value", "");
    expect(screen.queryAllByRole("option", { selected: true })).toEqual([]);
    fireEvent.keyDown(f.input, { key: "Enter" });
    expect(f.change).toHaveBeenCalledExactlyOnceWith("beta");
    expect(f.input).toHaveAttribute("data-value", "beta");
    expect(screen.getByRole("option", { name: "Beta notes" })).toHaveAttribute("aria-selected", "true");
    expect(f.input).toHaveFocus();
  });
  it("keeps a clicked choice without pinning non-matching rows into filtered results", () => {
    const f = show();
    fireEvent.click(screen.getByRole("option", { name: "Beta notes" }));
    fireEvent.change(f.input, { target: { value: "alpha" } });
    expect(screen.queryByRole("option", { name: "Beta notes" })).not.toBeInTheDocument();
    expect(screen.getByText("Selected:")).toHaveTextContent("Selected: Beta notes");
    expect(f.input).toHaveAttribute("data-value", "beta");
    expect(f.change).toHaveBeenCalledExactlyOnceWith("beta");
    expect(f.input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.change(f.input, { target: { value: "" } });
    expect(screen.getByRole("option", { name: "Beta notes" })).toHaveAttribute("aria-selected", "true");
  });
  it("announces empty/no-match states and keeps the explicit creation path available", () => {
    const create = vi.fn(), f = show({ onCreate: create });
    fireEvent.change(f.input, { target: { value: "nothing matches" } });
    expect(screen.getByRole("status")).toHaveTextContent("No collections match");
    fireEvent.keyDown(f.input, { key: "ArrowDown" });fireEvent.keyDown(f.input, { key: "Enter" });
    expect(f.change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create a new collection…" }));
    expect(create).toHaveBeenCalledOnce();expect(f.change).not.toHaveBeenCalled();
    fireEvent.change(f.input, { target: { value: "" } });
    expect(within(f.list).getAllByRole("option")).toHaveLength(3);
  });
  it("does not turn Escape or IME confirmation into a selection", () => {
    const f = show();fireEvent.keyDown(f.input, { key: "ArrowDown" });
    fireEvent.keyDown(f.input, { key: "Enter", isComposing: true });expect(f.change).not.toHaveBeenCalled();
    fireEvent.keyDown(f.input, { key: "Escape" });fireEvent.keyDown(f.input, { key: "Enter" });
    expect(f.change).not.toHaveBeenCalled();
  });
  it("does not choose a replacement when the highlighted collection disappears", () => {
    const change = vi.fn(), f = render(<CollectionPicker label="Collections" collections={choices} value="" onChoose={change} />);
    const input = screen.getByRole("combobox");fireEvent.keyDown(input, { key: "ArrowDown" });
    f.rerender(<CollectionPicker label="Collections" collections={[choices[0]!]} value="" onChoose={change} />);
    expect(input).not.toHaveAttribute("aria-activedescendant");fireEvent.keyDown(input, { key: "Enter" });
    expect(change).not.toHaveBeenCalled();
  });
  it("shows a genuine empty catalog without inventing an option", () => {
    const f = show({ collections: [] });expect(screen.getByRole("status")).toHaveTextContent("No collections are available");
    expect(within(f.list).queryAllByRole("option")).toEqual([]);
  });
  it("blocks pointer, keyboard and creation selection while busy", () => {
    const create = vi.fn(), f = show({ disabled: true, onCreate: create });
    expect(f.input).toBeDisabled();fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
    fireEvent.keyDown(f.input, { key: "ArrowDown" });fireEvent.keyDown(f.input, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Create a new collection…" }));
    expect(f.change).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled();
  });
});
