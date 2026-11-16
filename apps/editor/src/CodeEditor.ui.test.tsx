import { act, fireEvent, render, screen } from "./test/locale";
import { describe, expect, it, vi } from "vitest";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CodeEditor } from "./CodeEditor";
import type { ResolvedFileReference } from "./use-file-assets";
import type { ResolvedNoteEmbed } from "./note-embeds";
import { linkTargets } from "./test/link-targets";

vi.mock("./inline-pdf-viewer", () => ({
  mountInlinePdfViewer: vi.fn(() => ({ unmount: vi.fn() }))
}));

describe("editor autofocus ownership", () => {
  it.each([true, false])("does not steal an outside text input's focus (focused before mount=%s)", async (beforeMount) => {
    render(<input aria-label="Sidebar search" />);
    const search = screen.getByRole("textbox", { name: "Sidebar search" });
    if (beforeMount) search.focus();
    render(<CodeEditor value="A note" label="Note body" language="markdown" variant="writer" autoFocus />);
    if (!beforeMount) search.focus();
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(search).toHaveFocus();
  });

  it("still focuses the editor when no other control owns focus", async () => {
    render(<CodeEditor value="A note" label="Note body" language="markdown" variant="writer" autoFocus />);
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveFocus();
  });
});

describe("writer shortcuts", () => {
  it.each(["k", "b", "i"])("does not mutate read-only note text with Ctrl %s", (key) => {
    const onChange = vi.fn();
    render(<CodeEditor value="Read-only note" label="Note body" language="markdown" variant="writer" readOnly onChange={onChange} />);
    const body = screen.getByRole("textbox", { name: "Note body" });
    body.focus();
    fireEvent.keyDown(body, { key, ctrlKey: true });
    expect(body).toHaveTextContent("Read-only note");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses Ctrl K for a link without consuming Ctrl P", () => {
    const onChange = vi.fn();
    render(<CodeEditor value="" label="Note body" language="markdown" variant="writer" onChange={onChange} />);
    const body = screen.getByRole("textbox", { name: "Note body" });
    body.focus();
    fireEvent.keyDown(body, { key: "k", code: "KeyK", ctrlKey: true });
    expect(onChange).toHaveBeenCalledWith("[link](https://)");
    expect(fireEvent.keyDown(body, { key: "p", code: "KeyP", ctrlKey: true })).toBe(true);
  });
});

describe("writer Enter", () => {
  it.each([
    ["- item", "- item\n- ", "- item\n"],
    ["1. step", "1. step\n2. ", "1. step\n"],
    ["- [ ] task", "- [ ] task\n- [ ] ", "- [ ] task\n"],
    ["- a\n\n- b", "- a\n\n- b\n\n- ", "- a\n\n- b\n\n"],
    ["> quote", "> quote\n> ", "> quote\n"]
  ])("continues %j, then ends it on an empty line", (value, continued, ended) => {
    const onChange = vi.fn();
    render(<CodeEditor value={value} label="Note body" language="markdown" variant="writer" onChange={onChange} />);
    const body = screen.getByRole("textbox", { name: "Note body" });
    const view = EditorView.findFromDOM(body)!;
    view.focus();
    view.dispatch({ selection: { anchor: value.length } });
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(onChange).toHaveBeenLastCalledWith(continued);
    fireEvent.keyDown(body, { key: "Enter", code: "Enter", keyCode: 13 });
    expect(onChange).toHaveBeenLastCalledWith(ended);
  });
});

describe("touch formatting bar", () => {
  it("shows while the note has focus, even when a transaction follows the tap", async () => {
    const coarse = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList));
    try {
      render(<CodeEditor value="A note" label="Note body" language="markdown" variant="writer" />);
      const body = screen.getByRole("textbox", { name: "Note body" });
      const view = EditorView.findFromDOM(body)!;
      // A tap focuses the note and places the caret; another update lands in the same task.
      await act(async () => {
        body.focus();
        view.dispatch({ selection: { anchor: 1 }, userEvent: "select.pointer" });
        view.dispatch({ selection: { anchor: 2 } });
      });
      expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
      await act(async () => { body.blur(); });
      expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
    } finally {
      coarse.mockRestore();
    }
  });
});

describe("rendered Markdown links", () => {
  it("opens a rendered link without moving the caret into its source", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CodeEditor
      value={"Start here.\nRead [the documentation](https://mdbase.dev/docs/)."}
      label="Note body"
      language="markdown"
      variant="writer"
    />);

    const link = await screen.findByRole("link", { name: "the documentation" });
    expect(fireEvent.mouseDown(link)).toBe(false);
    fireEvent.click(link);

    expect(open).toHaveBeenCalledWith("https://mdbase.dev/docs/", "_blank", "noopener,noreferrer");
    expect(screen.getByRole("link", { name: "the documentation" })).toBeInTheDocument();
  });

  it("does not render wikilink examples inside code", async () => {
    render(<CodeEditor
      value={"`[[People/ada]]`\n\n```md\n[[People/grace]]\n```"}
      label="Note body"
      language="markdown"
      variant="writer"
    />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("writer presentation", () => {
  it("gives prose the platform's autocorrect and sentence capitals", () => {
    render(<CodeEditor value="Prose" label="Note body" language="markdown" variant="writer" />);
    const body = screen.getByRole("textbox", { name: "Note body" });
    expect(body).toHaveAttribute("autocorrect", "on");
    expect(body).toHaveAttribute("autocapitalize", "sentences");
    expect(body).toHaveAttribute("spellcheck", "true");
  });

  it("parses GitHub-flavoured strikethrough and hides its markers away from the caret", () => {
    const { container } = render(<CodeEditor value={"Start.\nThis is ~~gone~~ now."} label="Note body" language="markdown" variant="writer" quietMarkdown />);
    expect([...container.querySelectorAll(".cm-lp-strike")].map((text) => text.textContent)).toEqual(["gone"]);
    expect(container.querySelector(".cm-content")).not.toHaveTextContent("~~");
  });

  it("shows a link to a missing note differently from a working one", async () => {
    render(<CodeEditor value={"Start.\nSee [[Known]] and [[Missing]]."} label="Note body" language="markdown" variant="writer" quietMarkdown
      linkSuggestions={[{ path: "Known.md", title: "Known" }]}
      linkTargets={linkTargets("Today.md", { "[[Known]]": { kind: "note", path: "Known.md" } })} />);
    const missing = await screen.findByRole("link", { name: "Missing" });
    await vi.waitFor(() => expect(missing.ownerDocument.querySelector(".cm-lp-link-missing")).not.toBeNull(), { timeout: 3_000 });
    expect(screen.getByRole("link", { name: "Missing" })).toHaveClass("cm-lp-link-missing");
    expect(screen.getByRole("link", { name: "Known" })).not.toHaveClass("cm-lp-link-missing");
  });
});

describe("note transclusions", () => {
  it("names a full note once and keeps its content keyboard-scrollable", async () => {
    render(<CodeEditor value={"Intro.\n\n![[Notes/plan]]"} label="Note body" language="markdown" variant="writer"
      embeddedNotes={{ source: "Intro.\n\n![[Notes/plan]]", references: [{ ...noteReference, to: 23, key: "8:23", anchor: undefined, body: "# Project plan\n\nUseful content." }] }} onOpenLink={vi.fn()} />);
    const region = await screen.findByRole("region", { name: "Transclusion of Project plan" });
    expect(region.querySelector("h1")).toBeNull();
    expect(region).toHaveTextContent("Useful content.");
    const content = screen.getByLabelText("Content of Project plan");
    content.focus();
    expect(content).toHaveFocus();
  });

  it("does not reconfigure on unrelated renders or callback identities and keeps retained widgets fresh", async () => {
    const reconfigure = vi.spyOn(Compartment.prototype, "reconfigure");
    const first = vi.fn();
    const latest = vi.fn();
    const value = "Intro.\n\n![[Notes/plan#Decisions]]";
    const embeddedNotes = { source: value, references: [noteReference] };
    const props = {
      value, label: "Note body",
      language: "markdown" as const, variant: "writer" as const, embeddedNotes,
      onOpenLink: first, onVisibleNoteEmbeds: vi.fn(), onVisibleFileEmbeds: vi.fn(), onOpenFile: vi.fn()
    };
    const editor = render(<CodeEditor {...props} />);
    const button = await screen.findByRole("button", { name: "Open Project plan" });
    reconfigure.mockClear();
    editor.rerender(<CodeEditor {...props} className="unrelated" onOpenLink={latest}
      onVisibleNoteEmbeds={vi.fn()} onVisibleFileEmbeds={vi.fn()} onOpenFile={vi.fn()} />);
    expect(reconfigure).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open Project plan" })).toBe(button);
    fireEvent.click(button);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith("Notes/plan.md");
    const updatedNotes = { source: value, references: [{ ...noteReference, body: "Updated fragment", revision: "2" }] };
    editor.rerender(<CodeEditor {...props} onOpenLink={latest} embeddedNotes={updatedNotes} />);
    expect(reconfigure).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Transclusion of Project plan" })).toHaveTextContent("Updated fragment");
    editor.rerender(<CodeEditor {...props} onOpenLink={undefined} embeddedNotes={updatedNotes} />);
    expect(screen.queryByRole("button", { name: "Open Project plan" })).not.toBeInTheDocument();
    editor.rerender(<CodeEditor {...props} onOpenLink={latest} embeddedNotes={updatedNotes} />);
    expect(screen.getByRole("button", { name: "Open Project plan" })).toBeInTheDocument();
    reconfigure.mockRestore();
  });

  it("renders a resolved note fragment and opens its source note", async () => {
    const open = vi.fn();
    render(<CodeEditor
      value={"Intro.\n\n![[Notes/plan#Decisions]]"}
      label="Note body"
      language="markdown"
      variant="writer"
      embeddedNotes={{ source: "Intro.\n\n![[Notes/plan#Decisions]]", references: [noteReference] }}
      onOpenLink={open}
    />);

    const transclusion = await screen.findByRole("region", { name: "Transclusion of Project plan" });
    expect(transclusion).toHaveTextContent("Decisions");
    expect(transclusion).toHaveTextContent("Use the shared parser.");
    fireEvent.click(screen.getByRole("button", { name: "Open Project plan" }));
    expect(open).toHaveBeenCalledWith("Notes/plan.md");
  });
});

describe("PDF links and embeds", () => {
  it("retains file widgets across callback rerenders and updates changed assets", async () => {
    const reconfigure = vi.spyOn(Compartment.prototype, "reconfigure");
    const file = { ...pdfReference.file, path: "Documents/image.png", mediaType: "image/png", mediaClass: "image" as const };
    const reference: ResolvedFileReference = {
      ...pdfReference, file, asset: { status: "ready", file, url: "blob:first" }
    };
    const value = "Intro.\n\n![[Documents/image.png]]";
    const embeddedFiles = { source: value, references: [reference] };
    const first = vi.fn(), latest = vi.fn();
    const props = {
      value, label: "Note body",
      language: "markdown" as const, variant: "writer" as const, embeddedFiles
    };
    const editor = render(<CodeEditor {...props} onOpenFile={first} />);
    const button = await screen.findByRole("button", { name: "Open image.png" });
    reconfigure.mockClear();
    editor.rerender(<CodeEditor {...props} onOpenFile={latest} onVisibleFileEmbeds={vi.fn()} />);
    expect(reconfigure).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open image.png" })).toBe(button);
    fireEvent.click(button);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(reference.asset);
    const asset = { status: "ready" as const, file, url: "blob:updated" };
    editor.rerender(<CodeEditor {...props} onOpenFile={latest} embeddedFiles={{ source: value, references: [{ ...reference, asset }] }} />);
    expect(reconfigure).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "image.png" })).toHaveAttribute("src", "blob:updated");
    fireEvent.click(screen.getByRole("button", { name: "Open image.png" }));
    expect(latest).toHaveBeenLastCalledWith(asset);
    const updatedFiles = { source: value, references: [{ ...reference, asset }] };
    editor.rerender(<CodeEditor {...props} onOpenFile={undefined} embeddedFiles={updatedFiles} />);
    expect(screen.queryByRole("button", { name: "Open image.png" })).not.toBeInTheDocument();
    editor.rerender(<CodeEditor {...props} onOpenFile={latest} embeddedFiles={updatedFiles} />);
    expect(screen.getByRole("button", { name: "Open image.png" })).toBeInTheDocument();
    reconfigure.mockRestore();
  });

  it("keeps an image embed in place while typing above it, before the next parse lands", async () => {
    const file = { ...pdfReference.file, path: "Documents/image.png", mediaType: "image/png", mediaClass: "image" as const };
    const value = "Intro.\n\n![[Documents/image.png]]";
    const reference: ResolvedFileReference = { ...pdfReference, file, asset: { status: "ready", file, url: "blob:image" } };
    const embeddedFiles = { source: value, references: [reference] };
    const editor = render(<CodeEditor value={value} label="Note body" language="markdown" variant="writer" embeddedFiles={embeddedFiles} />);
    const image = await screen.findByRole("img", { name: "image.png" });
    const view = EditorView.findFromDOM(editor.container.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 6, insert: " More" } });
    // The parse handed over still describes the text before the edit.
    editor.rerender(<CodeEditor value={view.state.doc.toString()} label="Note body" language="markdown" variant="writer" embeddedFiles={embeddedFiles} />);
    expect(screen.getByRole("img", { name: "image.png" })).toBe(image);
    expect(view.state.sliceDoc(0, view.state.doc.lineAt(view.state.doc.length).from)).toBe("Intro. More\n\n");
  });

  it("focuses an embedded PDF in place without opening a modal", async () => {
    render(<CodeEditor
      value={"Intro.\n\n![[Documents/paper.pdf]]"}
      label="Note body"
      language="markdown"
      variant="writer"
      embeddedFiles={{ source: "Intro.\n\n![[Documents/paper.pdf]]", references: [pdfReference] }}
    />);

    const open = await screen.findByRole("button", { name: "Open paper.pdf" });
    fireEvent.click(open);

    const viewer = await screen.findByRole("region", { name: "Embedded PDF, paper.pdf" });
    expect(viewer).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "Preview paper.pdf" })).not.toBeInTheDocument();
  });

  it("opens a PDF wikilink in the file workspace", async () => {
    const openFile = vi.fn();
    render(<CodeEditor
      value={"Intro.\nRead [[Documents/paper.pdf]]."}
      label="Note body"
      language="markdown"
      variant="writer"
      files={[pdfReference.asset.file]}
      linkTargets={linkTargets("Today.md", { "[[Documents/paper.pdf]]": { kind: "file", path: "Documents/paper.pdf" } })}
      onOpenFileLink={openFile}
    />);

    fireEvent.click(await screen.findByRole("link", { name: "Documents/paper.pdf" }));
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith(pdfReference.asset.file));
  });
});

const pdfReference: ResolvedFileReference = {
  from: 8,
  to: 32,
  raw: "![[Documents/paper.pdf]]",
  target: "Documents/paper.pdf",
  format: "wikilink",
  block: true,
  file: {
    fileId: "00000000-0000-4000-8000-000000000003",
    path: "Documents/paper.pdf",
    revision: "pdf-1",
    contentDigest: `sha256:${"3".repeat(64)}`,
    size: 10,
    mediaType: "application/pdf",
    mediaClass: "pdf",
    modifiedAt: "2026-08-09T00:00:00Z"
  },
  asset: {
    status: "ready",
    url: "blob:pdf",
    file: {
      fileId: "00000000-0000-4000-8000-000000000003",
      path: "Documents/paper.pdf",
      revision: "pdf-1",
      contentDigest: `sha256:${"3".repeat(64)}`,
      size: 10,
      mediaType: "application/pdf",
      mediaClass: "pdf",
      modifiedAt: "2026-08-09T00:00:00Z"
    }
  }
};

const noteReference: ResolvedNoteEmbed = {
  from: 8,
  to: 33,
  target: "Notes/plan",
  anchor: "Decisions",
  format: "wikilink",
  kind: "embed",
  block: true,
  key: "8:33",
  status: "ready",
  path: "Notes/plan.md",
  title: "Project plan",
  body: "## Decisions\n\nUse the shared parser.",
  revision: "plan-1"
};
