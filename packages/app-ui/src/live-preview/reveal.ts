import { StateEffect, StateField, type EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { cellRange } from "./table-model.js";

/**
 * Which Markdown source is shown raw. Source is revealed only where a focused
 * selection touches it, so an unfocused note always reads as rendered text.
 *
 * While a mouse button is held, the revealed selection stays where it was:
 * revealing markers under a press would move the text the pointer is on and
 * turn a click into a stray drag. The reveal catches up on release.
 *
 * A block of table cells reveals nothing: it selects cells, not their text.
 */
interface RevealState {
  focused: boolean;
  pointer: boolean;
  cells: boolean;
  selection: EditorSelection;
}

const focusEffect = StateEffect.define<boolean>();
const pointerEffect = StateEffect.define<boolean>();

/** What is revealed, as a dependency for `EditorView.decorations.compute`. */
export const revealField = StateField.define<RevealState>({
  create: (state) => ({ focused: false, pointer: false, cells: false, selection: state.selection }),
  update(value, transaction) {
    let { focused, pointer } = value;
    for (const effect of transaction.effects) {
      if (effect.is(focusEffect) && !pointer) focused = effect.value;
      if (effect.is(pointerEffect)) pointer = effect.value;
    }
    const selection = pointer
      ? (transaction.docChanged ? value.selection.map(transaction.changes) : value.selection)
      : transaction.state.selection;
    const cells = pointer || (!transaction.docChanged && selection.eq(value.selection)) ? value.cells : !!cellRange(transaction.state);
    if (focused === value.focused && pointer === value.pointer && cells === value.cells && selection.eq(value.selection)) {
      return transaction.docChanged ? { focused, pointer, cells, selection } : value;
    }
    return { focused, pointer, cells, selection };
  }
});

export function revealTracking(): Extension {
  return [
    revealField,
    EditorView.focusChangeEffect.of((_state, focusing) => focusEffect.of(focusing)),
    // A field created while the view already has focus (a new view, a new
    // state, or a reconfiguration) never sees a focus change, so catch it up.
    ViewPlugin.define((view) => {
      let pending = false;
      const sync = () => {
        const reveal = view.state.field(revealField);
        // A held pointer settles focus on release.
        if (pending || reveal.pointer || view.hasFocus === reveal.focused) return;
        pending = true;
        queueMicrotask(() => {
          pending = false;
          const focused = view.hasFocus;
          const current = view.state.field(revealField);
          if (view.dom.isConnected && !current.pointer && focused !== current.focused) view.dispatch({ effects: focusEffect.of(focused) });
        });
      };
      sync();
      return { update: sync };
    }),
    EditorView.domEventHandlers({
      pointerdown(event, view) {
        if (event.pointerType !== "mouse" || event.button !== 0) return false;
        const release = () => {
          window.removeEventListener("pointerup", release, true);
          window.removeEventListener("pointercancel", release, true);
          // The release can follow a view teardown or a document swap.
          if (view.dom.isConnected) view.dispatch({ effects: [pointerEffect.of(false), focusEffect.of(view.hasFocus)] });
        };
        window.addEventListener("pointerup", release, true);
        window.addEventListener("pointercancel", release, true);
        view.dispatch({ effects: pointerEffect.of(true) });
        return false;
      }
    })
  ];
}

/**
 * Whether a focused selection touches [from, to]. Both edges count unless
 * `touchEnd` is false, for source whose end is where the text after it starts.
 */
export function isRevealed(state: EditorState, from: number, to: number, touchEnd = true): boolean {
  const reveal = state.field(revealField, false);
  if (!reveal?.focused || reveal.cells) return false;
  return reveal.selection.ranges.some((range) => range.to >= from && (touchEnd ? range.from <= to : range.from < to));
}

/** Whether a view update changed what is revealed, so decorations must be rebuilt. */
export function revealChanged(update: ViewUpdate): boolean {
  return update.startState.field(revealField, false) !== update.state.field(revealField, false);
}
