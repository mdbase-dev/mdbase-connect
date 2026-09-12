import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { CodeEditor } from "./CodeEditor";

/**
 * Regression tests for the confirmed HIGH finding:
 * editor-undo-after-background-remote-update-silently-overwrites-newer-authority-revision
 *
 * A background remote refresh replaces the CodeMirror document via the [value]
 * sync dispatch. Before the fix that replacement was an ordinary undoable
 * history entry, so a single Ctrl-Z resurrected stale local content through
 * onChange, re-armed autosave, and silently overwrote the newer authority
 * revision. These tests pin the boundary: undo must never cross an external
 * document replacement, while ordinary typing/undo/redo and the per-note
 * history restore (rememberedEditors/historyField) keep working.
 */

interface EditorPropsBase {
  label: string;
  language: "markdown";
  variant: "writer";
  documentId: string;
  onChange: (value: string) => void;
}

function baseProps(documentId: string, onChange: (value: string) => void): EditorPropsBase {
  return { label: "Note", language: "markdown", variant: "writer", documentId, onChange };
}

function viewOf(container: HTMLElement): EditorView {
  const host = container.querySelector<HTMLElement>(".cm-editor");
  const view = host ? EditorView.findFromDOM(host) : undefined;
  if (!view) throw new Error("CodeMirror view not reachable from mounted DOM");
  return view;
}

function typeInto(view: EditorView, insert: string): void {
  const position = view.state.doc.length;
  view.dispatch({
    changes: { from: position, to: position, insert },
    selection: { anchor: position + insert.length },
    userEvent: "input.type"
  });
}

// jsdom swallows CodeMirror's keydown handling (fireEvent.keyDown reports
// handled=false even though historyKeymap runs), so drive the same commands
// the Mod-z / Mod-y bindings dispatch directly.
function pressUndo(container: HTMLElement): boolean {
  const content = container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content element not mounted");
  content.focus();
  return undo(viewOf(container));
}

function pressRedo(container: HTMLElement): boolean {
  const content = container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content element not mounted");
  content.focus();
  return redo(viewOf(container));
}

describe("CodeEditor remote-apply undo boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("codeeditor remote apply undo boundary: single Ctrl-Z after external update never emits pre-remote local content", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <CodeEditor {...baseProps("boundary-note-a", onChange)} value="local v0" remoteApplyToken={0} />
    );
    const view = viewOf(container);

    typeInto(view, " plus local typing");
    rerender(<CodeEditor {...baseProps("boundary-note-a", onChange)} value="local v0 plus local typing" remoteApplyToken={0} />);
    expect(onChange).toHaveBeenCalledWith("local v0 plus local typing");

    // Background watcher applies a newer authority revision.
    vi.advanceTimersByTime(1000);
    rerender(<CodeEditor {...baseProps("boundary-note-a", onChange)} value="remote r1" remoteApplyToken={1} />);
    expect(view.state.doc.toString()).toBe("remote r1");

    onChange.mockClear();
    // History was reset at the external apply, so there is nothing to undo:
    // the command reports false and stale local text stays buried.
    expect(pressUndo(container)).toBe(false);
    expect(view.state.doc.toString()).toBe("remote r1");
    expect(onChange).not.toHaveBeenCalled();

    // Walking the whole remaining stack must never cross the boundary either.
    for (let i = 0; i < 4; i += 1) {
      expect(pressUndo(container)).toBe(false);
      expect(view.state.doc.toString()).toBe("remote r1");
      expect(onChange).not.toHaveBeenCalled();
    }
  });

  it("codeeditor remote apply undo boundary: clean session Ctrl-Z does not revert the whole remote document either", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <CodeEditor {...baseProps("boundary-note-b", onChange)} value="local v0" remoteApplyToken={0} />
    );

    vi.advanceTimersByTime(1000);
    rerender(<CodeEditor {...baseProps("boundary-note-b", onChange)} value="remote r1" remoteApplyToken={1} />);
    expect(viewOf(container).state.doc.toString()).toBe("remote r1");

    onChange.mockClear();
    pressUndo(container);
    expect(viewOf(container).state.doc.toString()).toBe("remote r1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("codeeditor remote apply undo boundary: redo cannot resurrect pre-remote content across the boundary", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <CodeEditor {...baseProps("boundary-note-f", onChange)} value="local v0" remoteApplyToken={0} />
    );
    const view = viewOf(container);

    typeInto(view, " plus local typing");
    pressUndo(container);
    expect(view.state.doc.toString()).toBe("local v0");
    // Stale "+typing" sits in the redo branch; then authority moves forward.
    rerender(<CodeEditor {...baseProps("boundary-note-f", onChange)} value="remote r1" remoteApplyToken={1} />);

    onChange.mockClear();
    // Redo across the reset boundary is unavailable by design: the whole
    // restored branch died with the re-initialized history field, so it can't
    // resurrect pre-remote content either.
    expect(pressRedo(container)).toBe(false);
    expect(view.state.doc.toString()).toBe("remote r1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("codeeditor remote apply undo boundary: typing and undo within the user session still work after the external update", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <CodeEditor {...baseProps("boundary-note-c", onChange)} value="local v0" remoteApplyToken={0} />
    );
    const view = viewOf(container);

    vi.advanceTimersByTime(1000);
    rerender(<CodeEditor {...baseProps("boundary-note-c", onChange)} value="remote r1" remoteApplyToken={1} />);

    typeInto(view, "XYZ");
    rerender(<CodeEditor {...baseProps("boundary-note-c", onChange)} value="remote r1XYZ" remoteApplyToken={1} />);
    expect(view.state.doc.toString()).toBe("remote r1XYZ");

    onChange.mockClear();
    expect(pressUndo(container)).toBe(true);
    expect(view.state.doc.toString()).toBe("remote r1");
    expect(onChange).toHaveBeenCalledWith("remote r1");
    expect(onChange).not.toHaveBeenCalledWith(expect.stringContaining("local v0"));
  });

  it("codeeditor remote apply undo boundary: redo still works for post-boundary edits", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <CodeEditor {...baseProps("boundary-note-d", onChange)} value="local v0" remoteApplyToken={0} />
    );
    const view = viewOf(container);

    vi.advanceTimersByTime(1000);
    rerender(<CodeEditor {...baseProps("boundary-note-d", onChange)} value="remote r1" remoteApplyToken={1} />);

    typeInto(view, "XYZ");
    rerender(<CodeEditor {...baseProps("boundary-note-d", onChange)} value="remote r1XYZ" remoteApplyToken={1} />);
    expect(pressUndo(container)).toBe(true);
    expect(view.state.doc.toString()).toBe("remote r1");

    expect(pressRedo(container)).toBe(true);
    expect(view.state.doc.toString()).toBe("remote r1XYZ");
  });

  it("codeeditor remote apply undo boundary: ordinary typing, undo, and redo without remote applies are unaffected", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodeEditor {...baseProps("boundary-note-g", onChange)} value="plain v0" />
    );
    const view = viewOf(container);

    typeInto(view, " one");
    // Cross history's 500ms new-group delay so the two typings are separate
    // undo events under fake timers.
    vi.advanceTimersByTime(600);
    typeInto(view, " two");
    onChange.mockClear();

    expect(pressUndo(container)).toBe(true);
    expect(view.state.doc.toString()).toBe("plain v0 one");
    expect(onChange).toHaveBeenCalledWith("plain v0 one");

    expect(pressUndo(container)).toBe(true);
    expect(view.state.doc.toString()).toBe("plain v0");

    expect(pressRedo(container)).toBe(true);
    expect(view.state.doc.toString()).toBe("plain v0 one");
    expect(onChange).toHaveBeenLastCalledWith("plain v0 one");
  });

  it("codeeditor remote apply undo boundary: away-and-back remount restores per-note undo history", () => {
    const onChange = vi.fn();
    const documentId = "boundary-note-e";
    const first = render(<CodeEditor {...baseProps(documentId, onChange)} value={"original\n"} />);
    const firstView = viewOf(first.container);

    typeInto(firstView, "kept edit");
    first.unmount();

    const second = render(<CodeEditor {...baseProps(documentId, onChange)} value={"original\nkept edit"} />);
    const secondView = viewOf(second.container);

    expect(pressUndo(second.container)).toBe(true);
    expect(secondView.state.doc.toString()).toBe("original\n");
  });

  it("codeeditor remote apply undo boundary: away-and-back after a remote apply restores only post-apply history", () => {
    const onChange = vi.fn();
    const documentId = "boundary-note-h";
    const first = render(<CodeEditor {...baseProps(documentId, onChange)} value={"original\n"} remoteApplyToken={0} />);
    const firstView = viewOf(first.container);

    typeInto(firstView, "stale edit");
    rerenderFirst(first, documentId, onChange, "original\nstale edit");
    // Authority replaces the document while this editor is mounted.
    rerenderFirst(first, documentId, onChange, "remote r1", 1);
    expect(firstView.state.doc.toString()).toBe("remote r1");

    typeInto(firstView, " kept");
    first.unmount();

    const second = render(<CodeEditor {...baseProps(documentId, onChange)} value={"remote r1 kept"} remoteApplyToken={1} />);
    const secondView = viewOf(second.container);

    onChange.mockClear();
    expect(pressUndo(second.container)).toBe(true);
    expect(secondView.state.doc.toString()).toBe("remote r1");
    expect(onChange).toHaveBeenCalledWith("remote r1");

    // Restored history still respects the boundary.
    pressUndo(second.container);
    expect(secondView.state.doc.toString()).toBe("remote r1");
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

function rerenderFirst(
  harness: ReturnType<typeof render>,
  documentId: string,
  onChange: (value: string) => void,
  value: string,
  token?: number
): void {
  harness.rerender(
    <CodeEditor {...baseProps(documentId, onChange)} value={value} remoteApplyToken={token ?? 0} />
  );
}
