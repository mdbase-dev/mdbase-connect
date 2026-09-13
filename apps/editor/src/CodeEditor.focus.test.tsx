import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditor } from "./CodeEditor";

vi.mock("./inline-pdf-viewer", () => ({
  mountInlinePdfViewer: vi.fn(() => ({ unmount: vi.fn() }))
}));

// Hold the mount callback across the user's choice of where to type.
let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  frames = new Map();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

function flushFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

describe("CodeEditor mount focus ownership", () => {
  it("keeps search typing out of the note when the lazy editor mounts later", async () => {
    let resolve!: (module: { default: typeof CodeEditor }) => void;
    const LazyEditor = lazy(() => new Promise<{ default: typeof CodeEditor }>((done) => { resolve = done; }));
    const onChange = vi.fn();
    render(<>
      <input aria-label="Search notes" />
      <Suspense fallback={<div>Loading editor</div>}>
        <LazyEditor value="Original note" label="Note body" onChange={onChange} autoFocus />
      </Suspense>
    </>);
    const search = screen.getByRole("textbox", { name: "Search notes" });
    search.focus();
    await act(async () => { resolve({ default: CodeEditor }); });
    expect(screen.getByRole("textbox", { name: "Note body" })).toBeInTheDocument();
    flushFrame();
    expect(search).toHaveFocus();
    await userEvent.keyboard("needle");
    expect(search).toHaveValue("needle");
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("Original note");
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea", "select", "contenteditable", "nested contenteditable"])(
    "preserves a different %s focused between mount and its frame", (kind) => {
      render(<>
        {kind === "input" ? <input aria-label="Other" />
          : kind === "textarea" ? <textarea aria-label="Other" />
          : kind === "select" ? <select aria-label="Other"><option>One</option></select>
          : <div contentEditable suppressContentEditableWarning tabIndex={0} aria-label="Other">
            {kind === "nested contenteditable" ? <span tabIndex={0} aria-label="Nested">Text</span> : "Text"}
          </div>}
        <CodeEditor value="Original note" label="Note body" autoFocus />
      </>);
      const other = screen.getByLabelText(kind === "nested contenteditable" ? "Nested" : "Other");
      other.focus();
      flushFrame();
      expect(other).toHaveFocus();
    }
  );

  it("autofocuses when no editable control owns focus", () => {
    render(<CodeEditor value="Original note" label="Note body" autoFocus />);
    expect(document.body).toHaveFocus();
    flushFrame();
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveFocus();
  });

  it("preserves focus already owned by this view", () => {
    render(<CodeEditor value="Original note" label="Note body" autoFocus />);
    const body = screen.getByRole("textbox", { name: "Note body" });
    body.focus();
    flushFrame();
    expect(body).toHaveFocus();
  });

  it("does not focus a destroyed view from a pending frame", () => {
    const { unmount } = render(<CodeEditor value="Original note" label="Note body" autoFocus />);
    unmount();
    flushFrame();
    expect(document.body).toHaveFocus();
  });
});
