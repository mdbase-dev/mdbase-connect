import { MagnifyingGlassIcon as Search, XIcon as X } from "./icons";
import { Fragment, useEffect, useMemo, useState } from "react";
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

export interface QuickOpenCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

type QuickOpenRow =
  | { kind: "note"; result: NoteSearchResult }
  | { kind: "command"; command: QuickOpenCommand };

interface QuickOpenSection {
  header?: string;
  row: QuickOpenRow;
}

export function QuickOpen({ index, recentPaths, types, commands = [], onSelect, onClose }: {
  index: NoteSearchEntry[];
  recentPaths: string[];
  types: CollectionTypeDescriptor[];
  commands?: QuickOpenCommand[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const commandMode = query.trimStart().startsWith(">");
  const commandQuery = (commandMode ? query.trimStart().slice(1) : query).trim();
  const results = useMemo(() => commandMode ? [] : commandQuery
    ? searchNoteResults(index, commandQuery, 12)
    : recentNotes(index, recentPaths).slice(0, 12), [commandMode, commandQuery, index, recentPaths]);
  const filteredCommands = useMemo(() => filterCommands(commands, commandQuery), [commands, commandQuery]);
  const showCommands = filteredCommands.length > 0 && (commandMode || !commandQuery || results.length === 0);
  const sections = useMemo(() => buildSections(results, filteredCommands, commandMode, showCommands),
    [commandMode, filteredCommands, results, showCommands]);
  const rows = sections.map((section) => section.row);
  useEffect(() => setActiveIndex(0), [query]);

  function choose(row: QuickOpenRow | undefined) {
    if (!row) return;
    if (row.kind === "command") {
      onClose();
      row.command.run();
      return;
    }
    onSelect(row.result.note.path);
    onClose();
  }

  return <Dialog titleId="quick-open-title" className="quick-open" onClose={onClose}>
      <h2 id="quick-open-title" className="sr-only">Quick open</h2>
      <div className="quick-open-search">
        <Search aria-hidden="true" />
        <label className="sr-only" htmlFor="quick-open-input">Find a note or action</label>
        <input
          id="quick-open-input"
          data-autofocus
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-results"
          aria-activedescendant={rows[activeIndex] ? `quick-open-${activeIndex}` : undefined}
          value={query}
          placeholder="Find a note by title or path, or type > for actions"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) => Math.min(rows.length - 1, current + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
            } else if (event.key === "Home" && rows.length) {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End" && rows.length) {
              event.preventDefault();
              setActiveIndex(rows.length - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(rows[activeIndex]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <button className="icon-button" aria-label="Close quick open" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <p className="sr-only" aria-live="polite">{commandMode ? "Matching actions" : commandQuery ? "Best matches" : "Recent notes and actions"}</p>
      <div id="quick-open-results" className="quick-open-results" role="listbox" aria-label="Matching notes and actions">
        {sections.map((section, rowIndex) => {
          const selected = activeIndex === rowIndex;
          const row = section.row;
          return <Fragment key={row.kind === "command" ? row.command.id : row.result.note.path}>
            {section.header && <div className="quick-open-section" aria-hidden="true">{section.header}</div>}
            {row.kind === "command" ? <button
              id={`quick-open-${rowIndex}`}
              role="option"
              aria-selected={selected}
              className={`quick-open-command${selected ? " selected" : ""}`}
              onMouseEnter={() => setActiveIndex(rowIndex)}
              onClick={() => choose(row)}
            ><span><strong>{row.command.label}</strong>{row.command.hint && <small className="search-result-context path">{row.command.hint}</small>}</span></button> : (() => {
              const result = row.result;
              return <button
                id={`quick-open-${rowIndex}`}
                role="option"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                onMouseEnter={() => setActiveIndex(rowIndex)}
                onClick={() => choose(row)}
              ><span>
                <strong><SearchMatchText text={noteTitle(result.note, types)} ranges={searchTextRanges(noteTitle(result.note, types), commandQuery)} /></strong>
                <small className={`search-result-context ${result.context.kind}`}><SearchMatchText text={result.context.text} ranges={result.context.ranges} /></small>
              </span></button>;
            })()}
          </Fragment>;
        })}
        {!rows.length && <p>{commandMode ? "No matching actions." : "No matching notes."}</p>}
      </div>
      <footer><span><kbd>↑↓</kbd> choose · <kbd>Enter</kbd> open · <kbd>&gt;</kbd> actions · <kbd>Esc</kbd> close</span></footer>
  </Dialog>;
}

function buildSections(
  results: NoteSearchResult[],
  commands: QuickOpenCommand[],
  commandMode: boolean,
  showCommands: boolean
): QuickOpenSection[] {
  const sections: QuickOpenSection[] = [];
  if (commandMode) {
    if (commands.length) sections.push({ header: "Actions", row: { kind: "command", command: commands[0] } });
    for (let index = 1; index < commands.length; index += 1) {
      sections.push({ row: { kind: "command", command: commands[index] } });
    }
    return sections;
  }
  if (results.length) {
    sections.push({ header: "Notes", row: { kind: "note", result: results[0] } });
    for (let index = 1; index < results.length; index += 1) {
      sections.push({ row: { kind: "note", result: results[index] } });
    }
  }
  if (showCommands && commands.length) {
    sections.push({ header: "Actions", row: { kind: "command", command: commands[0] } });
    for (let index = 1; index < commands.length; index += 1) {
      sections.push({ row: { kind: "command", command: commands[index] } });
    }
  }
  return sections;
}

function filterCommands(commands: QuickOpenCommand[], query: string): QuickOpenCommand[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return commands;
  return commands.filter((command) => [command.label, command.hint ?? ""]
    .some((text) => text.toLocaleLowerCase().includes(needle)));
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
    [">", "Actions in quick open"],
    ["↑ / ↓", "Move through the note list"],
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
