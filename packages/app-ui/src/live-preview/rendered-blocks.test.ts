// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { BlockWidget, drawnBlocks, isDrawn, renderedBlockLayer, renderedBlocks, type RenderedBlock } from "./rendered-blocks.js";
import { revealTracking } from "./reveal.js";

afterEach(() => { vi.restoreAllMocks(); });

const doc = "zero\none\ntwo\nthree\nfour";
const line = (number: number) => EditorState.create({ doc }).doc.line(number + 1);

function stateFor(blocks: readonly RenderedBlock[][], caret = 0, focused = false) {
  let state = EditorState.create({
    doc,
    selection: { anchor: caret },
    extensions: [revealTracking(), blocks.map((kind) => renderedBlocks.of(kind)), renderedBlockLayer, renderedBlockLayer]
  });
  if (focused) {
    const effects = state.facet(EditorView.focusChangeEffect).map((effect) => effect(state, true)).filter((effect) => effect !== null);
    state = state.update({ effects }).state;
  }
  return state;
}

const drawn = (state: EditorState) => state.facet(drawnBlocks).map(({ from, to }) => [from, to]);

it("draws a block over the whole lines that hold it", () => {
  const state = stateFor([[{ from: 7, to: 10 }]]);
  expect(drawn(state)).toEqual([[line(1).from, line(2).to]]);
  expect(isDrawn(state, line(2).from)).toBe(true);
  expect(isDrawn(state, line(3).from)).toBe(false);
});

it("draws the blocks of every kind once, in order", () => {
  const state = stateFor([[{ from: 15, to: 15 }], [{ from: 0, to: 0 }]]);
  expect(drawn(state)).toEqual([[0, 4], [line(3).from, line(3).to]]);
  const replaced: number[][] = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set !== "function") set.between(0, state.doc.length, (from, to) => { replaced.push([from, to]); });
  }
  expect(replaced).toEqual(drawn(state));
});

it("leaves a block inside a drawn one to the outer block", () => {
  const state = stateFor([[{ from: line(2).from, to: line(2).to }], [{ from: line(1).from, to: line(3).to }]]);
  expect(drawn(state)).toEqual([[line(1).from, line(3).to]]);
});

it("shows a block's source while a focused selection touches its lines", () => {
  const block = [{ from: 7, to: 10 }];
  const inside = line(2).from + 1;
  expect(drawn(stateFor([block], inside, true))).toEqual([]);
  // An unfocused note reads as rendered, and so does one with its caret elsewhere.
  expect(drawn(stateFor([block], inside))).toHaveLength(1);
  expect(drawn(stateFor([block], line(4).from, true))).toHaveLength(1);
});

class Probe extends BlockWidget {
  release: (() => void) | undefined;
  discarded: HTMLElement | undefined;
  constructor(protected readonly heightKey: string, private readonly later = true) { super(); }
  protected draw(_view: EditorView, hold: () => () => void) {
    if (this.later) this.release = hold();
    const element = document.createElement("div");
    element.className = "probe";
    return element;
  }
  protected override discard(element: HTMLElement) { this.discarded = element; }
}

function laidOut(height: number) {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
}

it("draws what a kind draws inside the box the editor measures", () => {
  const view = new EditorView({ doc });
  const widget = new Probe("probe:box", false);
  const box = widget.toDOM(view);
  expect(box.className).toBe("cm-lp-block");
  expect(box.firstElementChild?.className).toBe("probe");
  widget.destroy(box);
  expect(widget.discarded).toBe(box.firstElementChild);
  view.destroy();
});

it("holds a block at the height it last had until its content arrives", () => {
  const view = new EditorView({ doc });
  const measure = vi.spyOn(view, "requestMeasure");
  const first = new Probe("probe:height");
  expect(first.estimatedHeight).toBe(-1);
  const firstBox = first.toDOM(view);
  expect(firstBox.style.minHeight).toBe("");
  laidOut(120);
  first.release!();
  expect(measure).toHaveBeenCalledTimes(1);

  // The same content drawn again, as after scrolling away and back.
  const second = new Probe("probe:height");
  expect(second.estimatedHeight).toBe(120);
  const secondBox = second.toDOM(view);
  expect(secondBox.style.minHeight).toBe("120px");
  laidOut(90);
  second.release!();
  second.release!();
  expect(secondBox.style.minHeight).toBe("");
  expect(measure).toHaveBeenCalledTimes(2);
  expect(new Probe("probe:height").estimatedHeight).toBe(90);
  expect(new Probe("probe:other").estimatedHeight).toBe(-1);
  view.destroy();
});
