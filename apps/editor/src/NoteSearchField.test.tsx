import { fireEvent, render, screen, within } from "./test/locale";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NoteSearchField } from "./NoteSearchField";
import type { NoteFilter } from "./note-list-view";

function SearchHarness({ onResults = vi.fn() }: { onResults?: (first: boolean) => void }) {
  const [search, onSearch] = useState("");
  const [filter, onFilter] = useState<NoteFilter>();
  return <NoteSearchField search={search} filter={filter} onSearch={onSearch} onFilter={onFilter} tags={[{ name: "ideas", count: 4 }, { name: "writing", count: 2 }]} types={[{ name: "note", count: 3 }]} onResults={onResults} />;
}

describe("Search filters", () => {
  it("hints the key that focuses search and offers no other command", () => {
    const { container } = render(<SearchHarness />);
    expect(container.querySelector(".search-shortcut")).toHaveTextContent("/");
    expect(screen.queryByRole("button", { name: /Commands/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Search notes and files" }), { target: { value: "garden" } });
    expect(container.querySelector(".search-shortcut")).toBeNull();
  });

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
    fireEvent.change(input, { target: { value: "tag:wri" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["#writing2"]);
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
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.change(input, { target: { value: "#" } });
    expect(input).toHaveAttribute("aria-expanded", "true");
    fireEvent.blur(input, { relatedTarget: document.body });
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves Enter and Escape to the input method while composing", () => {
    const onResults = vi.fn();
    render(<SearchHarness onResults={onResults} />);
    const input = screen.getByRole("combobox", { name: "Search notes and files" });
    fireEvent.change(input, { target: { value: "かな" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(onResults).not.toHaveBeenCalled();
    expect(input).toHaveValue("かな");
  });

  it("clears with Escape, returns with the second, and enters results with ArrowDown or Enter", () => {
    const onResults = vi.fn();
    render(<SearchHarness onResults={onResults} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "garden" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(onResults).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onResults).toHaveBeenLastCalledWith(false);
    for (const key of ["ArrowDown", "Enter"]) {
      fireEvent.keyDown(input, { key });
      expect(onResults).toHaveBeenLastCalledWith(true);
    }
  });

  it("has an explicit empty state and leaves unrelated prose alone", () => {
    const onSearch = vi.fn();
    render(<NoteSearchField search="type:unknown" tags={[]} types={[]} onSearch={onSearch} onFilter={vi.fn()} />);
    expect(screen.getByText("No matching filters")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSearch).not.toHaveBeenCalled();
  });
});
