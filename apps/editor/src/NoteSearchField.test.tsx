import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NoteSearchField } from "./NoteSearchField";
import type { NoteFilter } from "./NoteList";

function SearchHarness() {
  const [search, onSearch] = useState("");
  const [filter, onFilter] = useState<NoteFilter>();
  return <NoteSearchField search={search} filter={filter} onSearch={onSearch} onFilter={onFilter} tags={[{ name: "ideas", count: 4 }, { name: "writing", count: 2 }]} types={[{ name: "note", count: 3 }]} onQuickOpen={() => {}} />;
}

describe("Search filters", () => {
  it("suggests #tags and type:types, preserving text and removing the filter token", () => {
    render(<SearchHarness />);
    const input = screen.getByRole("combobox", { name: "Search notes and files" });
    fireEvent.change(input, { target: { value: "garden #id" } });
    expect(screen.getByRole("listbox", { name: "Search filters" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("garden");
    fireEvent.click(screen.getByRole("button", { name: "Remove tag filter ideas" }));
    fireEvent.change(input, { target: { value: "type:n" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove type filter note" })).toBeInTheDocument();
  });

  it("browses filters, supports arrow selection and Escape, and closes on outside focus", () => {
    render(<SearchHarness />);
    const input = screen.getByRole("combobox", { name: "Search notes and files" });
    fireEvent.click(screen.getByRole("button", { name: "Search filters" }));
    const list = screen.getByRole("listbox", { name: "Search filters" });
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove tag filter writing" })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "#" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("has an explicit empty state and leaves unrelated prose alone", () => {
    const onSearch = vi.fn();
    render(<NoteSearchField search="type:unknown" tags={[]} types={[]} onSearch={onSearch} onFilter={vi.fn()} onQuickOpen={vi.fn()} />);
    expect(screen.getByText("No matching filters")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSearch).not.toHaveBeenCalled();
  });
});
