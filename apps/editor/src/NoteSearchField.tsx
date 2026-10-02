import { useRef, useState } from "react";
import { MagnifyingGlassIcon as Search, TagIcon as Filters, XIcon as X } from "./icons";
import type { NoteFilter } from "./NoteList";
import "./styles/note-actions.css";

export interface SearchFacet { name: string; count: number }

export function NoteSearchField({ search, filter, tags, types, onSearch, onFilter, onQuickOpen }: {
  search: string;
  filter?: NoteFilter;
  tags: SearchFacet[];
  types: SearchFacet[];
  onSearch: (value: string) => void;
  onFilter: (filter?: NoteFilter) => void;
  onQuickOpen: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [browse, setBrowse] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const token = /(?:^|\s)(#([^\s]*)|type:([^\s]*))$/.exec(search);
  const kind = token ? token[1].startsWith("#") ? "tag" : "type" : undefined;
  const needle = (token?.[2] ?? token?.[3] ?? "").toLocaleLowerCase();
  const suggestions: Array<{ filter: NoteFilter; count: number }> = [
    ...(kind !== "type" ? tags.map(({ name, count }) => ({ filter: { kind: "tag" as const, value: name }, count })) : []),
    ...(kind !== "tag" ? types.map(({ name, count }) => ({ filter: { kind: "type" as const, value: name }, count })) : [])
  ].filter(({ filter }) => !kind || filter.value.toLocaleLowerCase().includes(needle));
  const open = !dismissed && (browse || Boolean(token));
  const choose = (next: NoteFilter) => {
    onFilter(next);
    if (token) onSearch(search.slice(0, token.index).trimEnd());
    setBrowse(false);
    setDismissed(true);
    input.current?.focus();
  };
  return <div className="note-search-root" onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) { setBrowse(false); setDismissed(true); }
  }}>
    <div className="search-field">
      <Search aria-hidden="true" />
      {filter && <button className="search-filter-chip" aria-label={`Remove ${filter.kind} filter ${filter.value}`} onClick={() => onFilter(undefined)}><span>{filter.kind === "tag" ? `#${filter.value}` : filter.kind === "type" ? `type:${filter.value}` : filter.value}</span><X aria-hidden="true" /></button>}
      <label className="sr-only" htmlFor="note-search">Search notes and files</label>
      <input ref={input} id="note-search" value={search} onChange={(event) => { onSearch(event.target.value); setDismissed(false); setActive(0); }} onFocus={() => setDismissed(false)} placeholder="Search" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? "note-filter-suggestions" : undefined} aria-activedescendant={open && suggestions.length ? `note-filter-${Math.min(active, suggestions.length - 1)}` : undefined} onKeyDown={(event) => {
        if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setBrowse(false); setDismissed(true); }
        if (!open || !suggestions.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive((value) => (value + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length); }
        if (event.key === "Enter") { event.preventDefault(); choose(suggestions[Math.min(active, suggestions.length - 1)].filter); }
      }} />
      {search ? <button aria-label="Clear search" onClick={() => onSearch("")}><X aria-hidden="true" /></button> : !filter && <button className="quick-open-trigger" aria-label="Quick open" title={`Quick open · ${navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}P`} onClick={onQuickOpen}><kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} P</kbd></button>}
      <button aria-label="Search filters" aria-expanded={open} aria-controls={open ? "note-filter-suggestions" : undefined} onClick={() => { setBrowse((value) => !value); setDismissed(false); setActive(0); }}><Filters aria-hidden="true" /></button>
    </div>
    {open && <div id="note-filter-suggestions" className="search-filter-suggestions" role="listbox" aria-label="Search filters">
      {suggestions.map(({ filter, count }, index) => <button key={`${filter.kind}:${filter.value}`} id={`note-filter-${index}`} role="option" aria-selected={index === active} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(filter)}><span>{filter.kind === "tag" ? `#${filter.value}` : `type:${filter.value}`}</span><small>{count}</small></button>)}
      {!suggestions.length && <p>No matching filters</p>}
    </div>}
  </div>;
}
