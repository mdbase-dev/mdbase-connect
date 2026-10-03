import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BacklinksPanel } from "./WorkspaceChrome";
import { buildNoteSearchIndex } from "./note-search";
import { unlinkedMentions } from "./unlinked-mentions";
import type { NoteSummary } from "./model";

const notes: NoteSummary[] = Array.from({ length: 8 }, (_, index) => ({
  path: `Source ${index + 1}.md`, body: `# Source ${index + 1}\n\nI keep **Atlas** in my notes.`, types: [], frontmatter: {}, effectiveFrontmatter: {},
  file: { path: `Source ${index + 1}.md`, name: `Source ${index + 1}.md`, folder: "", size: 40, mtime: "" }
}));
const mentions = unlinkedMentions(buildNoteSearchIndex(notes), "Atlas.md", "Atlas");

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
