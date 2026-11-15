import { t } from "@lingui/core/macro";
import type { EditorView } from "@codemirror/view";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";

export interface WritingAction {
  label: string;
  icon: ComponentType<{ "aria-hidden"?: boolean }>;
  run: (view: EditorView) => boolean;
}

/** How far the on-screen keyboard covers the bottom of the layout viewport. */
function useKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)));
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

/**
 * Formatting for touch screens, on the on-screen keyboard while someone writes: phone keyboards
 * make Markdown's marks and Tab slow to reach. Pressing a button never moves focus out of the
 * note, so the keyboard stays up; Done puts it away. `reserve` tells the editor how much of the
 * bottom of the screen the keyboard and bar cover, so the caret scrolls clear of them.
 */
export function WritingToolbar({ view, actions, reserve }: {
  view: EditorView;
  actions: readonly WritingAction[];
  reserve: (bottom: number) => void;
}) {
  const inset = useKeyboardInset();
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    reserve(inset + (bar.current?.offsetHeight ?? 0));
    // The keyboard arriving covers the caret; bring it back into view above the bar.
    view.dispatch({ scrollIntoView: true });
    return () => reserve(0);
  }, [inset, reserve, view]);
  return createPortal(<div
    ref={bar}
    // With no on-screen keyboard (a hardware one, say), the bar sits on the screen's safe area.
    className={`writing-toolbar${inset ? "" : " is-docked"}`}
    role="toolbar"
    aria-label={t`Formatting`}
    style={{ transform: `translateY(${-inset}px)` }}
    // Keep focus, and with it the keyboard, in the note.
    onPointerDown={(event) => event.preventDefault()}
    onMouseDown={(event) => event.preventDefault()}
  >
    <div className="writing-toolbar-actions">
      {actions.map(({ label, icon: Icon, run }) => <button
        key={label}
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        onClick={() => { run(view); view.focus(); }}
      ><Icon aria-hidden /></button>)}
    </div>
    <button type="button" className="writing-toolbar-done" onClick={() => view.contentDOM.blur()}>{t`Done`}</button>
  </div>, view.dom.ownerDocument.body);
}
