import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { typewriterScrolling } from "./code-editor-typewriter";
let view: EditorView | undefined;
afterEach(() => { view?.destroy(); view = undefined; });

describe("typewriter scrolling", () => {
  it("centres the focused caret after selection changes without modifying text", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({ parent, doc: "First line\nSecond line", extensions: [typewriterScrolling] });
    view.focus();
    view.dispatch({ selection: { anchor: 14 } });
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback(0);
    expect(scroll).toHaveBeenCalledWith(14, { y: "center" });
    expect(view.state.doc.toString()).toBe("First line\nSecond line");
    view.destroy(); view = undefined; parent.remove();
    scroll.mockRestore();
  });
});
