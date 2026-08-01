import { MagnifyingGlassIcon as Search, XIcon as X } from "./icons";
import { useEffect, useMemo, useState } from "react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { Dialog } from "./Dialog";
import { noteTitle } from "./note";
import {
  searchNoteResults,
  searchTextRanges,
  type NoteSearchEntry,
  type NoteSearchResult
} from "./note-search";
import { SearchMatchText } from "./SearchMatchText";

export function QuickOpen({ index, recentPaths, types, onSelect, onClose }: {
  index: NoteSearchEntry[];
  recentPaths: string[];
  types: CollectionTypeDescriptor[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(() => query.trim()
    ? searchNoteResults(index, query, 12)
    : recentNotes(index, recentPaths).slice(0, 12), [index, query, recentPaths]);
  useEffect(() => setActiveIndex(0), [query]);

  function choose(result: NoteSearchResult | undefined) {
    if (!result) return;
    onSelect(result.note.path);
    onClose();
  }

  return <Dialog titleId="quick-open-title" className="quick-open" onClose={onClose}>
      <h2 id="quick-open-title" className="sr-only">Quick open</h2>
      <div className="quick-open-search">
        <Search aria-hidden="true" />
        <label className="sr-only" htmlFor="quick-open-input">Find a note</label>
        <input
          id="quick-open-input"
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-results"
          aria-activedescendant={results[activeIndex] ? `quick-open-${activeIndex}` : undefined}
          value={query}
          placeholder="Find a note by title or path"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => Math.min(results.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(results[activeIndex]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button className="icon-button" aria-label="Close quick open" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <p className="sr-only" aria-live="polite">{query.trim() ? "Best matches" : "Recent notes"}</p>
      <div id="quick-open-results" className="quick-open-results" role="listbox" aria-label="Matching notes">
        {results.map((result, noteIndex) => <button
          id={`quick-open-${noteIndex}`}
          role="option"
          aria-selected={activeIndex === noteIndex}
          className={activeIndex === noteIndex ? "selected" : ""}
          key={result.note.path}
          onMouseEnter={() => setActiveIndex(noteIndex)}
          onClick={() => choose(result)}
        ><span>
          <strong><SearchMatchText text={noteTitle(result.note, types)} ranges={searchTextRanges(noteTitle(result.note, types), query)} /></strong>
          <small className={`search-result-context ${result.context.kind}`}><SearchMatchText text={result.context.text} ranges={result.context.ranges} /></small>
        </span></button>)}
        {!results.length && <p>No matching notes.</p>}
      </div>
      <footer><span><kbd>↑↓</kbd> choose · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</span></footer>
  </Dialog>;
}

function recentNotes(index: NoteSearchEntry[], paths: string[]): NoteSearchResult[] {
  const byPath = new Map(index.map((entry) => [entry.note.path, entry.note]));
  const recent = paths.flatMap((path) => {
    const note = byPath.get(path);
    return note ? [{ note, context: { kind: "path" as const, text: note.path, ranges: [] } }] : [];
  });
  if (recent.length) return recent;
  return index.slice(0, 12).map((entry) => ({
    note: entry.note,
    context: { kind: "path" as const, text: entry.note.path, ranges: [] }
  }));
}

export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const modifier = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
  const shortcuts = [
    [`${modifier} P`, "Quick open"],
    [`${modifier} F`, "Find in note"],
    [`${modifier} B / I`, "Bold or italic"],
    [`${modifier} K`, "Add a link"],
    ["/", "Markdown commands"],
    ["Alt ← / →", "Back or forward"],
    ["Alt J / K", "Next or previous note"],
    [`${modifier} Shift N`, "New note"],
    [`${modifier} Shift L`, "Show or hide the notes sidebar"],
    ["?", "Show this shortcut guide"]
  ];
  return <Dialog titleId="shortcut-help-title" className="shortcut-help" onClose={onClose}>
      <header><h2 id="shortcut-help-title">Shortcuts</h2><button className="icon-button" aria-label="Close keyboard shortcuts" onClick={onClose}><X aria-hidden="true" /></button></header>
      <dl>{shortcuts.map(([keys, label]) => <div key={label}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl>
  </Dialog>;
}
