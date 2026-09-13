import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Compartment } from "@codemirror/state";
import { CodeEditor } from "./CodeEditor";
import type { ResolvedFileReference } from "./use-file-assets";
import type { ResolvedNoteEmbed } from "./note-embeds";

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

describe("note transclusions", () => {
  it("does not reconfigure on unrelated renders or callback identities and keeps retained widgets fresh", async () => {
    const reconfigure = vi.spyOn(Compartment.prototype, "reconfigure");
    const first = vi.fn();
    const latest = vi.fn();
    const embeddedNotes = [noteReference];
    const props = {
      value: "Intro.\n\n![[Notes/plan#Decisions]]", label: "Note body",
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
    const updatedNotes = [{ ...noteReference, body: "Updated fragment", revision: "2" }];
    editor.rerender(<CodeEditor {...props} onOpenLink={latest} embeddedNotes={updatedNotes} />);
    expect(reconfigure).toHaveBeenCalledTimes(1);
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
      embeddedNotes={[noteReference]}
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
    const embeddedFiles = [reference];
    const first = vi.fn(), latest = vi.fn();
    const props = {
      value: "Intro.\n\n![[Documents/image.png]]", label: "Note body",
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
    editor.rerender(<CodeEditor {...props} onOpenFile={latest} embeddedFiles={[{ ...reference, asset }]} />);
    expect(reconfigure).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "image.png" })).toHaveAttribute("src", "blob:updated");
    fireEvent.click(screen.getByRole("button", { name: "Open image.png" }));
    expect(latest).toHaveBeenLastCalledWith(asset);
    const updatedFiles = [{ ...reference, asset }];
    editor.rerender(<CodeEditor {...props} onOpenFile={undefined} embeddedFiles={updatedFiles} />);
    expect(screen.queryByRole("button", { name: "Open image.png" })).not.toBeInTheDocument();
    editor.rerender(<CodeEditor {...props} onOpenFile={latest} embeddedFiles={updatedFiles} />);
    expect(screen.getByRole("button", { name: "Open image.png" })).toBeInTheDocument();
    reconfigure.mockRestore();
  });

  it("focuses an embedded PDF in place without opening a modal", async () => {
    render(<CodeEditor
      value={"Intro.\n\n![[Documents/paper.pdf]]"}
      label="Note body"
      language="markdown"
      variant="writer"
      embeddedFiles={[pdfReference]}
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
      onOpenFileLink={openFile}
    />);

    fireEvent.click(await screen.findByRole("link", { name: "Documents/paper.pdf" }));
    expect(openFile).toHaveBeenCalledWith(pdfReference.asset.file);
  });
});

const pdfReference: ResolvedFileReference = {
  from: 8,
  to: 32,
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
