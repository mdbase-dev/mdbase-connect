import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { describe, expect, it, vi } from "vitest";
import { CodeEditor } from "./CodeEditor";
import { clipboardAttachments } from "./code-editor-file-embeds";

function transfer(files: File[] = [], text = "") {
  return { files, items: [], types: files.length ? ["Files"] : ["text/plain"], getData: () => text } as unknown as DataTransfer;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const image = () => new File(["pixels"], "image.png", { type: "image/png" });
function editor(upload?: (file: File) => Promise<string>, readOnly = false) {
  const change = vi.fn();
  const rendered = render(<CodeEditor value={"Before.\n\nAfter."} label="Note body" language="markdown" variant="writer"
    onChange={change} onUploadAttachment={upload} readOnly={readOnly} />);
  const body = screen.getByRole("textbox", { name: "Note body" });
  const view = EditorView.findFromDOM(body)!;
  return { ...rendered, body, view, change };
}

describe("attachment capture", () => {
  it("names clipboard screenshots without renaming dropped files or altering bytes/types", async () => {
    const file = image();
    const named = clipboardAttachments(transfer([file]), new Date(2026, 9, 3, 7, 12))[0]!;
    expect(named.name).toBe("Pasted image 2026-10-03 07.12.png");
    expect(named.size).toBe(file.size);
    expect(named.type).toBe(file.type);
    const pdf = new File(["pdf"], "paper.pdf", { type: "application/pdf" });
    expect(clipboardAttachments(transfer([pdf]))).toEqual([pdf]);
    const getAsFile = vi.fn(() => file);
    const fromItems = clipboardAttachments({ files: [] as unknown as FileList,
      items: [{ kind: "file", getAsFile }] as unknown as DataTransferItemList });
    expect(fromItems).toHaveLength(1);
    expect(getAsFile).toHaveBeenCalledTimes(1);
  });

  it("keeps an image upload out of saved Markdown, maps it through typing, and isolates undo/redo", async () => {
    const gate = deferred<string>();
    const upload = vi.fn(() => gate.promise);
    const { body, view, change } = editor(upload);
    act(() => view.dispatch({ selection: { anchor: 9 } }));
    expect(fireEvent.paste(body, { clipboardData: transfer([image()]) })).toBe(false);
    expect(screen.getByRole("status")).toHaveTextContent(/Uploading Pasted image/);
    expect(change).not.toHaveBeenCalled();
    act(() => view.dispatch({ changes: { from: 0, insert: "Typed " }, selection: { anchor: 0 } }));
    await act(async () => gate.resolve("![Screenshot](<Notes/Attachments/screenshot.png>)"));
    expect(view.state.doc.toString()).toBe("Typed Before.\n\n![Screenshot](<Notes/Attachments/screenshot.png>)\n\nAfter.");
    expect(view.state.selection.main.head).toBe(0); // completion never steals the caret
    expect(screen.queryByText(/Uploading Pasted image/)).not.toBeInTheDocument();
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("Typed Before.\n\nAfter.");
    act(() => { expect(redo(view)).toBe(true); });
    expect(view.state.doc.toString()).toContain("Attachments/screenshot.png");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("uses drop coordinates, keeps multi-file ordering, and removes its quiet drag hint", async () => {
    const first = deferred<string>();
    const upload = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce("[two](<Attachments/two.txt>)");
    const { view, body } = editor(upload);
    const coordinates = vi.spyOn(view, "posAtCoords").mockReturnValue(9);
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    const files = [new File(["one"], "one.txt"), new File(["two"], "two.txt")];
    expect(fireEvent.dragOver(body, { dataTransfer: transfer(files) })).toBe(false);
    expect(view.dom).toHaveClass("is-file-drag-over");
    const drop = new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 50, clientY: 75 });
    Object.defineProperty(drop, "dataTransfer", { value: transfer(files) });
    fireEvent(body, drop);
    expect(coordinates).toHaveBeenCalledWith({ x: 50, y: 75 });
    expect(view.dom).not.toHaveClass("is-file-drag-over");
    expect(screen.getAllByRole("status")).toHaveLength(2);
    await act(async () => first.resolve("[one](<Attachments/one.txt>)"));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map(([file]) => file.name)).toEqual(["one.txt", "two.txt"]);
    expect(view.state.doc.toString()).toBe("Before.\n\n[one](<Attachments/one.txt>)\n\n[two](<Attachments/two.txt>)\n\nAfter.");
  });

  it("offers retry/remove on network errors and continues other dropped files", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce("[two](<Attachments/two.txt>)")
      .mockResolvedValueOnce("[one](<Attachments/one.txt>)");
    const { view, body } = editor(upload);
    vi.spyOn(view, "posAtCoords").mockReturnValue(9);
    fireEvent.drop(body, { dataTransfer: transfer([new File(["a"], "one.txt"), new File(["b"], "two.txt")]) });
    const retry = await screen.findByRole("button", { name: "Retry upload of one.txt" });
    expect(screen.getByRole("status")).toHaveTextContent("Couldn’t upload one.txt. Check your connection and try again.");
    expect(view.state.doc.toString()).toContain("Attachments/two.txt");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(view.state.doc.toString()).toBe("Before.\n\n[one](<Attachments/one.txt>)\n\n[two](<Attachments/two.txt>)\n\nAfter.");
  });

  it.each(["paste", "drop"])("renders a block image placeholder and inserts its own Markdown lines mid-paragraph via %s", async (gesture) => {
    const gate = deferred<string>();
    const { body, view, change } = editor(() => gate.promise);
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Before after." }, selection: { anchor: 7 } }));
    vi.spyOn(view, "posAtCoords").mockReturnValue(7);
    change.mockClear();
    if (gesture === "paste") fireEvent.paste(body, { clipboardData: transfer([image()]) });
    else fireEvent.drop(body, { dataTransfer: transfer([image()]) });
    const widget = screen.getByRole("status").parentElement!;
    expect(widget).toHaveClass("is-block");
    expect(widget.tagName).toBe("DIV");
    expect(widget.closest(".cm-line")).toBeNull(); // a block decoration, not an inline chip
    expect(view.state.doc.toString()).toBe("Before after.");
    expect(change).not.toHaveBeenCalled();
    await act(async () => gate.resolve("![Image](<Attachments/image.png>)"));
    expect(view.state.doc.toString()).toBe("Before \n\n![Image](<Attachments/image.png>)\n\nafter.");
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe("Before after.");
  });

  it.each([
    ["File exceeds the upload limit.", "scan.pdf is too large to upload."],
    ["Unsupported media type from gateway", "scan.pdf is a file type that can’t be uploaded."],
    ["Object upload failed with HTTP 403.", "You don’t have permission to upload scan.pdf."]
  ])("offers only Remove for a permanent upload failure (%s)", async (diagnostic, message) => {
    const upload = vi.fn().mockRejectedValue(new Error(diagnostic));
    const { body, view } = editor(upload);
    fireEvent.paste(body, { clipboardData: transfer([new File(["pdf"], "scan.pdf", { type: "application/pdf" })]) });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
    expect(screen.queryByRole("button", { name: /Retry upload/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove upload of scan.pdf" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(view.state.doc.toString()).toBe("Before.\n\nAfter.");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each(["remove", "unmount", "delete anchor", "replace at start"])("does not insert a late reference after %s", async (action) => {
    const gate = deferred<string>();
    const { body, view, unmount, change } = editor(() => gate.promise);
    act(() => view.dispatch({ selection: { anchor: action === "replace at start" ? 0 : 9 } }));
    fireEvent.paste(body, { clipboardData: transfer([image()]) });
    if (action === "remove") fireEvent.click(screen.getByRole("button", { name: /Remove upload/ }));
    if (action === "unmount") unmount();
    if (action === "delete anchor") act(() => view.dispatch({ changes: { from: 0, to: 10 } }));
    if (action === "replace at start") act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Remote replacement" } }));
    change.mockClear();
    await act(async () => gate.resolve("![Image](<Attachments/image.png>)"));
    expect(change).not.toHaveBeenCalled();
  });

  it("cannot capture files or show a drag target while read-only or without attachment access", () => {
    const upload = vi.fn();
    const { body, view, rerender } = editor(upload, true);
    const data = transfer([image()]);
    fireEvent.paste(body, { clipboardData: data });
    fireEvent.drop(body, { dataTransfer: data });
    fireEvent.dragOver(body, { dataTransfer: data });
    expect(upload).not.toHaveBeenCalled();
    expect(view.dom).not.toHaveClass("is-file-drag-over");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(<CodeEditor value={"Before.\n\nAfter."} label="Note body" language="markdown" variant="writer" />);
    fireEvent.paste(body, { clipboardData: data });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("blocks late completion when frozen and disables widget actions", async () => {
    const gate = deferred<string>();
    const upload = vi.fn(() => gate.promise);
    const { body, view, rerender } = editor(upload);
    fireEvent.paste(body, { clipboardData: transfer([image()]) });
    rerender(<CodeEditor value={"Before.\n\nAfter."} label="Note body" language="markdown" variant="writer"
      onUploadAttachment={upload} readOnly />);
    await act(async () => gate.resolve("![Image](<Attachments/image.png>)"));
    expect(view.state.doc.toString()).toBe("Before.\n\nAfter.");
    expect(screen.queryByRole("button", { name: /Retry upload/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove upload/ })).toBeDisabled();
  });

  it("leaves normal plain-text paste and selected-text URL-to-link paste alone", () => {
    const upload = vi.fn();
    const { view, body } = editor(upload);
    fireEvent.paste(body, { clipboardData: transfer([], "hello ") });
    expect(view.state.doc.toString()).toBe("hello Before.\n\nAfter.");
    act(() => view.dispatch({ selection: { anchor: 6, head: 12 } }));
    fireEvent.paste(body, { clipboardData: transfer([], "https://example.org/") });
    expect(view.state.doc.toString()).toContain("[Before](https://example.org/)");
    expect(upload).not.toHaveBeenCalled();
  });
});
