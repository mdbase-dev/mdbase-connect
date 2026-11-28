import { render, screen, waitFor, within } from "./test/locale";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BacklinksPanel } from "./WorkspaceChrome";
import { backlinkGroups } from "./collection-links";
import { unlinkedMentions } from "./unlinked-mentions";
import type { NoteSummary } from "./model";

const notes: NoteSummary[] = Array.from({ length: 8 }, (_, index) => ({
  path: `Source ${index + 1}.md`, body: `# Source ${index + 1}\n\nI keep **Atlas** in my notes.`, types: [], frontmatter: {}, effectiveFrontmatter: {},
  file: { path: `Source ${index + 1}.md`, name: `Source ${index + 1}.md`, folder: "", size: 40, mtime: "" }
}));
const mentions = unlinkedMentions(notes, "Atlas.md", "Atlas");

describe("unlinked mention disclosure", () => {
  it("uses the shared chevron, lazily shows five plain highlighted snippets, and expands only on request", async () => {
    const user = userEvent.setup();
    const open = vi.fn(), link = vi.fn();
    const view = render(<BacklinksPanel notes={[]} types={[]} loading={false} mentions={mentions} onOpen={open} onLinkMention={link} />);
    const summary = screen.getByText("Unlinked mentions (8)");
    const disclosure = summary.closest("details")!;
    expect(disclosure).toHaveClass("settings-details");
    expect(disclosure.querySelector("summary svg")).toHaveAttribute("aria-hidden", "true");
    expect(view.container.querySelectorAll(".unlinked-mention")).toHaveLength(0);
    await user.click(summary);
    await screen.findByRole("button", { name: "Show all 8" });
    expect(view.container.querySelectorAll(".unlinked-mention")).toHaveLength(5);
    expect(view.container.querySelectorAll("mark")).toHaveLength(5);
    expect(view.container.querySelector(".unlinked-mention small")).toHaveTextContent("I keep Atlas in my notes.");
    expect(view.container.querySelector(".unlinked-mention mark")).toHaveTextContent("Atlas");
    await user.click(screen.getByRole("button", { name: /^Source 1/ }));
    expect(open).toHaveBeenCalledWith("Source 1.md");
    await user.click(screen.getByRole("button", { name: "Link mention in Source 1" }));
    expect(link).toHaveBeenCalledWith(mentions[0]);
    await user.click(screen.getByRole("button", { name: "Show all 8" }));
    expect(view.container.querySelectorAll(".unlinked-mention")).toHaveLength(8);
    await user.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(view.container.querySelectorAll(".unlinked-mention")).toHaveLength(5);
    await user.click(summary);
    await waitFor(() => expect(view.container.querySelectorAll(".unlinked-mention")).toHaveLength(0));
    await user.click(summary);
    await screen.findByRole("button", { name: "Show all 8" });
    expect(view.container.querySelectorAll(".unlinked-mention")).toHaveLength(5);
  });
});

describe("linked from, by type", () => {
  const types = [
    { name: "book", schema: {}, collection: { display: { icon: "book-open" } }, extensions: {} },
    { name: "meeting", schema: {}, extensions: {} }
  ];
  const linking = (path: string, noteTypes: string[], fields: string[] = []) => ({
    note: { ...notes[0]!, path, body: `# ${path.replace(/\.md$/, "")}`, types: noteTypes, file: { ...notes[0]!.file, path } },
    fields
  });

  it("groups linking notes by their first declared type, typed groups by name and plain notes last", () => {
    const groups = backlinkGroups([
      linking("Scratch.md", []),
      linking("Standup.md", ["Meeting"]),
      linking("Dune.md", ["undeclared", "book"], ["author"]),
      linking("Emma.md", ["book"])
    ], types);
    expect(groups.map((group) => [group.type, group.icon, group.notes.map((entry) => entry.note.path)])).toEqual([
      ["book", "book-open", ["Dune.md", "Emma.md"]],
      ["meeting", undefined, ["Standup.md"]],
      [undefined, undefined, ["Scratch.md"]]
    ]);
  });

  it("heads each kind of note with its count and says which property holds the link", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(<BacklinksPanel notes={[linking("Dune.md", ["book"], ["author"]), linking("Emma.md", ["book"]), linking("Scratch.md", [])]} types={types} loading={false} onOpen={open} />);
    const books = screen.getByRole("group", { name: "Book" });
    expect(within(books).getByRole("heading", { level: 3 })).toHaveTextContent("Book2");
    expect(within(books).getByRole("button", { name: /^Dune/ })).toHaveTextContent("Duneauthor");
    expect(within(books).getByRole("button", { name: /^Emma/ })).toHaveTextContent("EmmaEmma.md");
    expect(within(screen.getByRole("group", { name: "Notes" })).getByRole("button", { name: /^Scratch/ })).toBeInTheDocument();
    await user.click(within(books).getByRole("button", { name: /^Dune/ }));
    expect(open).toHaveBeenCalledWith("Dune.md");
  });

  it("keeps one plain list where no linking note has a type", () => {
    render(<BacklinksPanel notes={[linking("Scratch.md", [])]} types={types} loading={false} onOpen={vi.fn()} />);
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Scratch/ })).toBeInTheDocument();
  });
});
