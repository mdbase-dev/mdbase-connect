import { FileText, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { NoteSummary } from "./model";
import { noteTitle } from "./note";
import { searchNotes, type NoteSearchEntry } from "./note-search";

export function QuickOpen({ index, recentPaths, onSelect, onClose }: {
  index: NoteSearchEntry[];
  recentPaths: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const notes = useMemo(() => query.trim()
    ? searchNotes(index, query, 12)
    : recentNotes(index, recentPaths).slice(0, 12), [index, query, recentPaths]);
  useEffect(() => setActiveIndex(0), [query]);

  function choose(note: NoteSummary | undefined) {
    if (!note) return;
    onSelect(note.path);
    onClose();
  }

  return <div className="dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="quick-open" role="dialog" aria-modal="true" aria-labelledby="quick-open-title">
      <h2 id="quick-open-title" className="sr-only">Quick open</h2>
      <div className="quick-open-search">
        <Search aria-hidden="true" />
        <label className="sr-only" htmlFor="quick-open-input">Find a note</label>
        <input
          id="quick-open-input"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-results"
          aria-activedescendant={notes[activeIndex] ? `quick-open-${activeIndex}` : undefined}
          value={query}
          placeholder="Find a note by title or path"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => Math.min(notes.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(notes[activeIndex]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button className="icon-button" aria-label="Close quick open" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <p className="quick-open-heading">{query.trim() ? "Best matches" : "Recent notes"}</p>
      <div id="quick-open-results" className="quick-open-results" role="listbox" aria-label="Matching notes">
        {notes.map((note, noteIndex) => <button
          id={`quick-open-${noteIndex}`}
          role="option"
          aria-selected={activeIndex === noteIndex}
          className={activeIndex === noteIndex ? "selected" : ""}
          key={note.path}
          onMouseEnter={() => setActiveIndex(noteIndex)}
          onClick={() => choose(note)}
        ><FileText aria-hidden="true" /><span><strong>{noteTitle(note)}</strong><small>{note.path}</small></span></button>)}
        {!notes.length && <p>No matching notes.</p>}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
    </section>
  </div>;
}

function recentNotes(index: NoteSearchEntry[], paths: string[]): NoteSummary[] {
  const byPath = new Map(index.map((entry) => [entry.note.path, entry.note]));
  const recent = paths.flatMap((path) => {
    const note = byPath.get(path);
    return note ? [note] : [];
  });
  if (recent.length) return recent;
  return index.slice(0, 12).map((entry) => entry.note);
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const modifier = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
  const shortcuts = [
    [`${modifier} K`, "Quick open"],
    ["Alt J / K", "Next or previous note"],
    [`${modifier} Shift N`, "New note"],
    [`${modifier} Shift L`, "Show or hide the notes sidebar"],
    ["?", "Show this shortcut guide"]
  ];
  return <div className="dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="shortcut-help" role="dialog" aria-modal="true" aria-labelledby="shortcut-help-title">
      <header><div><p className="eyebrow">Keyboard</p><h2 id="shortcut-help-title">Shortcuts</h2></div><button className="icon-button" aria-label="Close keyboard shortcuts" onClick={onClose}><X aria-hidden="true" /></button></header>
      <dl>{shortcuts.map(([keys, label]) => <div key={label}><dt>{label}</dt><dd>{keys.split(" ").map((key, index) => <kbd key={`${key}:${index}`}>{key}</kbd>)}</dd></div>)}</dl>
    </section>
  </div>;
}
