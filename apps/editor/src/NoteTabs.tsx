import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useRef, type KeyboardEvent } from "react";
import { XIcon as X } from "./icons";
import type { NoteTab } from "./workspace";

/** The open tabs above the editor. Arrow keys move between tabs and Enter shows one,
 * since showing a note reads it; Delete closes the focused tab, as a middle click does. */
export function NoteTabs({ tabs, active, label, onSelect, onClose }: {
  tabs: readonly NoteTab[];
  active: string;
  label: (tab: NoteTab) => string;
  onSelect: (tab: NoteTab) => void;
  onClose: (tab: NoteTab) => void;
}) {
  useLingui();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (event.key === "Delete") {
      event.preventDefault();
      onClose(tabs[index]!);
      return;
    }
    const next = event.key === "ArrowRight" ? index + 1
      : event.key === "ArrowLeft" ? index - 1
      : event.key === "Home" ? 0
      : event.key === "End" ? tabs.length - 1
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    buttons.current.get(tabs[(next + tabs.length) % tabs.length]!.id)?.focus();
  };
  return <div className="note-tabs" role="tablist" aria-label={t`Open tabs`}>
    {tabs.map((tab, index) => {
      const selected = tab.id === active;
      const name = label(tab);
      return <div key={tab.id} className={`note-tab${selected ? " is-active" : ""}`} title={name}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          onClose(tab);
        }}>
        <button role="tab" aria-selected={selected} tabIndex={selected ? 0 : -1}
          ref={(button) => { if (button) buttons.current.set(tab.id, button); else buttons.current.delete(tab.id); }}
          onClick={() => onSelect(tab)} onKeyDown={(event) => onKeyDown(event, index)}>
          <span>{name}</span>
        </button>
        <button className="note-tab-close" tabIndex={-1} aria-label={t`Close ${name}`} onClick={() => onClose(tab)}><X aria-hidden="true" /></button>
      </div>;
    })}
  </div>;
}
