import { fireEvent, render, screen } from "./test/locale";
import { describe, expect, it, vi } from "vitest";
import { quickOpenResults, ShortcutHelp } from "./QuickOpen";
import { CommandPalette } from "@mdbase-dev/ui/command-palette";
import { buildNoteSearchIndex } from "./note-search";

function QuickOpen({ initialCommandMode, onClose, ...options }: Parameters<typeof quickOpenResults>[0] & { initialCommandMode?: boolean; onClose: () => void }) {
  return <CommandPalette open commands={[]} initialQuery={initialCommandMode ? ">" : ""} onClose={onClose} getResults={query => quickOpenResults(options, query)} />;
}

describe("keyboard discovery", () => {
  it("carries the actual action context into shared palette results", () => {
    const results = quickOpenResults({ index: [], recentPaths: [], types: [], onSelect: vi.fn(), commands: [
      { id: "rename", label: "Rename", context: "Garden notes", run: vi.fn() }
    ] }, ">");
    expect(results[0]).toMatchObject({ id: "rename", context: "Garden notes" });
  });
  it("keeps explicit search relevance ahead of contextual fuzzy matches", () => {
    const results = quickOpenResults({ index: [], recentPaths: [], types: [], onSelect: vi.fn(), commands: [
      { id: "pin", label: "Pin", run: vi.fn() }, { id: "unpin", label: "Unpin", context: "Garden notes", run: vi.fn() }
    ] }, ">pin");
    expect(results[0].id).toBe("pin");
    for (const result of results) expect(result).not.toHaveProperty("context", expect.anything());
  });
  it("uses shared navigation-key labels in shortcut help", () => {
    render(<ShortcutHelp canRename onClose={() => {}} />);
    const help = screen.getByRole("dialog", { name: "Shortcuts" });
    expect(help).not.toHaveTextContent(/ArrowDown|ArrowUp|ArrowLeft|ArrowRight|ContextMenu/);
    expect(screen.getByText("↓", { selector: "kbd" })).toBeInTheDocument();
    expect(screen.getByText("↑", { selector: "kbd" })).toBeInTheDocument();
    expect(screen.getByText("Menu", { selector: "kbd" })).toBeInTheDocument();
  });
  it("puts recent notes first without hiding other notes and highlights typed matches", () => {
    const index = buildNoteSearchIndex(["First", "Recent", "Last"].map(title => ({
      path: `${title}.md`, frontmatter: {}, effectiveFrontmatter: {}, types: [], body: title,
      file: { path: `${title}.md`, name: `${title}.md`, folder: "", size: title.length, mtime: "" }
    })));
    render(<QuickOpen index={index} recentPaths={["Recent.md"]} types={[]} commands={[]} onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual([
      "RecentRecent.md", "FirstFirst.md", "LastLast.md"
    ]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Recent" } });
    expect(screen.getByRole("option").querySelector("mark")).toHaveTextContent("Recent");
  });
  it("offers the trimmed empty-search title for creation by Enter, not in command mode", () => {
    const create = vi.fn(), close = vi.fn();
    render(<QuickOpen index={[]} recentPaths={[]} types={[]} commands={[]} onSelect={() => {}} onCreate={create} onClose={close} />);
    const input = screen.getByRole("combobox");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "  New idea  " } });
    expect(screen.getByRole("option", { name: "Create note ‘New idea’" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(create).toHaveBeenCalledWith("New idea");
    expect(close).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { value: ">missing" } });
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("does not offer creation without create permission", () => {
    render(<QuickOpen index={[]} recentPaths={[]} types={[]} commands={[]} onSelect={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "New idea" } });
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });
  it.each(["MacIntel", "iPad", "Linux x86_64"])("shows one quick-open chord and link-only K on %s", (platform) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    render(<ShortcutHelp canRename onClose={() => {}} />);
    const modifier = platform === "Linux x86_64" ? "Ctrl" : "⌘";
    const separator = platform === "Linux x86_64" ? "+" : "";
    expect(screen.getByText(`${modifier}${separator}P`, { selector: "kbd" })).toBeInTheDocument();
    expect(screen.getAllByText(`${modifier}${separator}K`, { selector: "kbd" })).toHaveLength(1);
    expect(screen.getByText("Commands", { selector: "dt" })).toHaveTextContent("Commandsoutside text; add a link while typing");
    expect(screen.getByText("outside text; add a link while typing", { selector: "small" })).toBeInTheDocument();
    for (const group of ["Navigate", "Note", "Text"]) expect(screen.getByRole("heading", { name: group })).toBeInTheDocument();
    expect(screen.getByText("G T", { selector: "kbd" })).toBeInTheDocument();
  });

  it("opens command mode directly, fuzzy matches actions and displays shortcut chips", () => {
    const run = vi.fn(), close = vi.fn();
    render(<QuickOpen index={[]} recentPaths={[]} types={[]} initialCommandMode commands={[{ id: "focus", label: "Focus mode", hint: "Keep the note visible", shortcut: "mod+shift+F", run }, { id: "copy-path", label: "Copy path", run }]} onSelect={() => {}} onClose={close} />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveValue(">");
    expect(screen.getByText("Keep the note visible", { selector: "small" })).toBeInTheDocument();
    expect(screen.getByText(/Shift\+F/, { selector: "kbd" })).toBeInTheDocument();
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
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toHaveTextContent("Action 19");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    fireEvent.change(input, { target: { value: ">missing" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.change(input, { target: { value: ">Action 0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledOnce();
  });
});
