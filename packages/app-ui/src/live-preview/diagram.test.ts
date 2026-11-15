// @vitest-environment jsdom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { blockPreview } from "./blocks.js";
import { DiagramWidget } from "./diagram.js";
import { revealTracking } from "./reveal.js";

const pele = vi.hoisted(() => ({ mountAsync: vi.fn() }));
vi.mock("pele/lazy", () => ({ mountAsync: pele.mountAsync }));

beforeEach(() => {
  pele.mountAsync.mockReset();
  pele.mountAsync.mockImplementation(async (element: HTMLElement) => {
    element.innerHTML = '<svg><a href="https://example.com/"><text>web</text></a><a href="Some note"><text>note</text></a></svg>';
    return { destroy: vi.fn() };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const diagram = "```mermaid\nflowchart LR\n  A --> B\n```";

function stateFor(doc: string, caret?: number, focused = false) {
  let state = EditorState.create({
    doc,
    selection: { anchor: caret ?? doc.length },
    extensions: [markdown({ base: markdownLanguage }), revealTracking(), blockPreview()]
  });
  if (focused) {
    const effects = state.facet(EditorView.focusChangeEffect).map((effect) => effect(state, true)).filter((effect) => effect !== null);
    state = state.update({ effects }).state;
  }
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

function diagrams(state: EditorState) {
  const found: Array<{ from: number; to: number; source: string }> = [];
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === "function") continue;
    (decorations as DecorationSet).between(0, state.doc.length, (from, to, value) => {
      const widget = value.spec.widget;
      if (widget instanceof DiagramWidget) found.push({ from, to, source: widget.source });
    });
  }
  return found;
}

it("renders a closed top-level mermaid fence as one block", () => {
  const doc = `Intro\n\n${diagram}\n\nAfter`;
  const state = stateFor(doc, 0);
  expect(diagrams(state)).toEqual([{ from: 7, to: 7 + diagram.length, source: "flowchart LR\n  A --> B" }]);
});

it("shows the source while a focused selection is inside it", () => {
  const doc = `Intro\n\n${diagram}\n\nAfter`;
  expect(diagrams(stateFor(doc, doc.indexOf("A -->"), true))).toEqual([]);
  // An unfocused editor keeps the diagram, wherever its selection is.
  expect(diagrams(stateFor(doc, doc.indexOf("A -->")))).toHaveLength(1);
  // A caret on the next line does not touch the fence.
  expect(diagrams(stateFor(doc, doc.indexOf("After"), true))).toHaveLength(1);
});

it("leaves other, unclosed, empty and nested fences as code", () => {
  expect(diagrams(stateFor("```js\nflowchart LR\n```\n\nx", 0))).toEqual([]);
  expect(diagrams(stateFor("```mermaid\nflowchart LR\n  A --> B", 0))).toEqual([]);
  expect(diagrams(stateFor("```mermaid\n  \n```\n\nx", 0))).toEqual([]);
  expect(diagrams(stateFor("> ```mermaid\n> flowchart LR\n> ```\n\nx", 0))).toEqual([]);
  expect(diagrams(stateFor("~~~Mermaid\nflowchart LR\n~~~\n\nx", 0))).toHaveLength(1);
});

function fakeView(doc: string) {
  let state = EditorState.create({ doc });
  return {
    get state() { return state; },
    dispatch: vi.fn((spec: Parameters<EditorState["update"]>[0]) => { state = state.update(spec).state; }),
    focus: vi.fn(),
    posAtDOM: vi.fn(() => doc.indexOf("```")),
    requestMeasure: vi.fn()
  } as unknown as EditorView & { dispatch: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; requestMeasure: ReturnType<typeof vi.fn> };
}

it("mounts the source with fixed options that keep images and app navigation out", async () => {
  const view = fakeView(`x\n${diagram}`);
  const dom = new DiagramWidget("flowchart LR\n  A --> B").toDOM(view);
  await vi.waitFor(() => expect(pele.mountAsync).toHaveBeenCalledTimes(1));
  const [element, source, options] = pele.mountAsync.mock.calls[0];
  expect(dom.contains(element)).toBe(true);
  expect(source).toBe("flowchart LR\n  A --> B");
  expect(options).toMatchObject({ images: false, linkSchemes: ["http", "https", "mailto"], linkRel: "noopener noreferrer" });
  expect(options).not.toHaveProperty("config");
});

it("opens web links in a new tab and never navigates for other links", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const dom = new DiagramWidget("flowchart LR").toDOM(fakeView(diagram));
  await vi.waitFor(() => expect(dom.querySelectorAll("a")).toHaveLength(2));
  const [web, note] = dom.querySelectorAll("a");
  const click = (target: Element) => { const event = new MouseEvent("click", { bubbles: true, cancelable: true }); target.dispatchEvent(event); return event; };
  expect(click(web.firstElementChild!).defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
  open.mockClear();
  expect(click(note).defaultPrevented).toBe(true);
  expect(open).not.toHaveBeenCalled();
});

it("Edit puts the caret on the first source line", () => {
  const doc = `x\n${diagram}\n`;
  const view = fakeView(doc);
  const dom = new DiagramWidget("flowchart LR").toDOM(view);
  dom.querySelector<HTMLButtonElement>(".cm-lp-diagram-edit")!.click();
  expect(view.state.selection.main.head).toBe(doc.indexOf("flowchart"));
  expect(view.focus).toHaveBeenCalled();
});

it("destroys a mount that finishes after the widget is gone", async () => {
  const destroy = vi.fn();
  let finish!: () => void;
  pele.mountAsync.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ destroy }); }));
  const widget = new DiagramWidget("flowchart LR");
  const dom = widget.toDOM(fakeView(diagram));
  await vi.waitFor(() => expect(pele.mountAsync).toHaveBeenCalled());
  widget.destroy(dom);
  finish();
  await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
});

it("says so when the renderer cannot load, and tries again for the next diagram", async () => {
  vi.resetModules();
  vi.doMock("pele/lazy", () => { throw new Error("chunk failed"); });
  const { DiagramWidget: Fresh } = await import("./diagram.js");
  const failed = new Fresh("flowchart LR").toDOM(fakeView(diagram));
  await vi.waitFor(() => expect(failed.querySelector(".cm-lp-diagram-failed")?.textContent).toMatch(/could not be shown/));
  expect(pele.mountAsync).not.toHaveBeenCalled();
  vi.doMock("pele/lazy", () => ({ mountAsync: pele.mountAsync }));
  new Fresh("flowchart LR").toDOM(fakeView(diagram));
  await vi.waitFor(() => expect(pele.mountAsync).toHaveBeenCalledTimes(1));
});
