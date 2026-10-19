import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { readRememberedCollection } from "./portal-model";

interface CollectionChoice { id: string; name: string; hint?: string; kind?: "private" }

/** Manual-selection combobox. Query, highlight and committed choice are
 * independent: neither filtering nor keyboard navigation grants consent. */
export function CollectionPicker({ label, collections, value, onChoose, disabled = false, onCreate, creationSelected = false }: {
  label: string;
  collections: readonly CollectionChoice[];
  value: string;
  onChoose(id: string): void;
  disabled?: boolean;
  onCreate?: () => void;
  creationSelected?: boolean;
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // Reuse the portal's existing last-used preference as a ranking hint only.
  const [recent] = useState(readRememberedCollection);
  const sorted = useMemo(() => [...collections].sort((a, b) =>
    Number(b.id === recent) - Number(a.id === recent)
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id)
  ), [collections, recent]);
  const filtered = sorted.filter(collection => collection.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const active = filtered.findIndex(collection => collection.id === highlighted);
  const selected = collections.find(collection => collection.id === value);

  useEffect(() => {
    if (active >= 0) list.current?.children[active]?.scrollIntoView?.({ block: "nearest" });
  }, [active, highlighted]);

  function choose(collection: CollectionChoice) {
    if (disabled) return;
    setHighlighted(collection.id);
    onChoose(collection.id);
    input.current?.focus();
  }

  return <div className="collection-picker">
    <label id={`${id}-label`} htmlFor={`${id}-input`}>{label}</label>
    <input
      ref={input} id={`${id}-input`} role="combobox" type="search" autoComplete="off" data-value={value}
      aria-labelledby={`${id}-label`} aria-autocomplete="list" aria-expanded="true"
      aria-controls={`${id}-list`} aria-activedescendant={active >= 0 ? `${id}-option-${active}` : undefined}
      aria-describedby={`${id}-help`} placeholder="Search collections by name" value={query} disabled={disabled}
      onChange={event => { setQuery(event.currentTarget.value); setHighlighted(null); }}
      onKeyDown={event => {
        if (disabled || event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!filtered.length) return;
          const next = active < 0 ? (event.key === "ArrowDown" ? 0 : filtered.length - 1)
            : Math.max(0, Math.min(filtered.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
          setHighlighted(filtered[next]!.id);
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (active >= 0) choose(filtered[active]!);
        } else if (event.key === "Escape") {
          event.preventDefault(); setHighlighted(null);
        }
      }}
    />
    <span id={`${id}-help`} className="sr-only">Type to filter. Arrow keys highlight; Enter chooses. Typing does not change your choice.</span>
    <div ref={list} id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} aria-disabled={disabled} className="collection-picker-list">
      {filtered.map((collection, index) => <div
        key={collection.id} id={`${id}-option-${index}`} role="option" aria-label={collection.name} data-value={collection.id}
        aria-selected={collection.id === value} aria-disabled={disabled}
        aria-describedby={collection.kind === "private" || collection.hint || collection.id === recent ? `${id}-hint-${index}` : undefined}
        className={`collection-picker-option${collection.id === value ? " is-selected" : ""}${index === active ? " is-highlighted" : ""}`}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(collection)}
      >
        <strong>{collection.kind === "private" && <span className="collection-picker-lock" aria-hidden="true">🔒 </span>}{collection.name}</strong>
        {(collection.kind === "private" || collection.hint || collection.id === recent) && <small id={`${id}-hint-${index}`}>
          {[collection.id === recent ? "Recently used" : null, collection.kind === "private" ? "Private" : null, collection.hint].filter(Boolean).join(" · ")}
        </small>}
        {collection.id === value && <span className="collection-picker-check" aria-hidden="true">✓</span>}
      </div>)}
    </div>
    {filtered.length === 0 && <p className="field-note" role="status">{collections.length ? "No collections match. Try another name." : "No collections are available."}</p>}
    {onCreate && <button className="collection-picker-create" type="button" disabled={disabled} aria-pressed={creationSelected}
      onClick={() => { setHighlighted(null); onCreate(); }}>Create a new collection…</button>}
    {selected && <p className="field-note collection-picker-selection" aria-live="polite">Selected: <strong>{selected.name}</strong></p>}
  </div>;
}
