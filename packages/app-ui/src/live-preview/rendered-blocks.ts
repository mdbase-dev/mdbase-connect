import { Facet, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { isRevealed, revealField } from "./reveal.js";

/**
 * Source shown as one drawn block: a diagram, a display formula, an embed, a
 * folded callout body. The block stands for the whole lines that hold
 * [from, to], and its source shows instead while a focused selection touches
 * those lines.
 */
export interface RenderedBlock {
  from: number;
  to: number;
  /** What is drawn in the lines' place. Without one the lines are only hidden. */
  widget?: BlockWidget;
}

/**
 * Every rendered block in the note. Each kind of block provides its own, from
 * its own state; this is the one place they become decorations, so every kind
 * is revealed by the same rule and two kinds never draw over the same lines.
 */
export const renderedBlocks = Facet.define<readonly RenderedBlock[]>();

function resolve(state: EditorState): readonly RenderedBlock[] {
  const blocks = state.facet(renderedBlocks).flat().map((block) => ({
    ...block, from: state.doc.lineAt(block.from).from, to: state.doc.lineAt(block.to).to
  })).sort((a, b) => a.from - b.from || b.to - a.to);
  const drawn: RenderedBlock[] = [];
  let end = -1;
  for (const block of blocks) {
    // A block inside a drawn one, such as an embed in a folded callout, is covered by it.
    if (block.from <= end || isRevealed(state, block.from, block.to)) continue;
    drawn.push(block);
    end = block.to;
  }
  return drawn;
}

const drawn = Facet.define<readonly RenderedBlock[], readonly RenderedBlock[]>({ combine: (values) => values[0] ?? [] });

/** The blocks that are drawn: on whole lines, in order, none inside another, none whose source is revealed. */
export const drawnBlocks = drawn.reader;

/** Whether a drawn block stands for the line at `position`. */
export function isDrawn(state: EditorState, position: number): boolean {
  return state.facet(drawnBlocks).some((block) => block.from <= position && position <= block.to);
}

/** Draws `renderedBlocks`. Each provider of blocks includes it; it is installed once. */
export const renderedBlockLayer: Extension = [
  drawn.compute([renderedBlocks, revealField], resolve),
  EditorView.decorations.compute([drawn], (state): DecorationSet => Decoration.set(state.facet(drawnBlocks).map((block): Range<Decoration> =>
    Decoration.replace({ block: true, widget: block.widget }).range(block.from, block.to))))
];

/** Last drawn height per block, so one drawn again takes its space before its content arrives. */
const heights = new Map<string, number>();
const HEIGHT_ENTRIES = 512;
function rememberHeight(key: string, height: number) {
  heights.delete(key);
  heights.set(key, height);
  if (heights.size > HEIGHT_ENTRIES) heights.delete(heights.keys().next().value!);
}

interface Host { view: EditorView; key: string; holds: number }
const hosts = new WeakMap<Element, Host>();
// CodeMirror measures a block when the editor updates, not when the block's own content arrives.
const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const host = hosts.get(target);
    if (!host) continue;
    const height = (target as HTMLElement).offsetHeight;
    if (!host.holds && height > 0) rememberHeight(host.key, height);
    host.view.requestMeasure();
  }
});

/**
 * A widget drawn between lines of text. CodeMirror places every later line by
 * the heights of the blocks before it, so a block's height has to be what
 * CodeMirror thinks it is, before it is drawn, while it loads and after:
 *
 * - The block is measured by its border box. What a kind draws sits inside a
 *   box that contains its margins, so they count.
 * - A block not yet drawn is estimated at the height it last had.
 * - A block whose content arrives later holds that height meanwhile, and
 *   CodeMirror measures it again whenever its size changes.
 */
export abstract class BlockWidget extends WidgetType {
  /** Names what is drawn, across every kind of block: two blocks with one key are as tall as each other. */
  protected abstract readonly heightKey: string;

  /**
   * Draws the block. A kind whose content arrives later calls `hold` first and
   * the function it returns once the content is in place.
   */
  protected abstract draw(view: EditorView, hold: () => () => void): HTMLElement;

  /** Releases what `draw` made, given the element it returned. */
  protected discard(_drawn: HTMLElement): void {}

  get estimatedHeight() { return heights.get(this.heightKey) ?? -1; }

  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-lp-block";
    const host: Host = { view, key: this.heightKey, holds: 0 };
    const height = heights.get(this.heightKey);
    box.append(this.draw(view, () => {
      host.holds += 1;
      if (height) box.style.minHeight = `${height}px`;
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        host.holds -= 1;
        if (host.holds) return;
        box.style.minHeight = "";
        if (box.offsetHeight > 0) rememberHeight(host.key, box.offsetHeight);
        view.requestMeasure();
      };
    }));
    hosts.set(box, host);
    resized?.observe(box);
    return box;
  }

  destroy(box: HTMLElement) {
    resized?.unobserve(box);
    hosts.delete(box);
    if (box.firstElementChild instanceof HTMLElement) this.discard(box.firstElementChild);
  }
}
