import { CheckIcon as Check, SlidersHorizontalIcon as SlidersHorizontal } from "./icons";
import { useEffect, useRef, useState } from "react";
import { noteSortOptions, type NoteSort } from "./note-list-view";

export function NoteListViewOptions({ sort, scopeLabel, onSort, onClearScope }: {
  sort: NoteSort;
  scopeLabel?: string;
  onSort: (sort: NoteSort) => void;
  onClearScope: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus();
    const closeForOutsidePress = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = (current + direction + items.length) % items.length;
      event.preventDefault();
      items[next]?.focus();
    };
    document.addEventListener("pointerdown", closeForOutsidePress);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePress);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const select = (action: () => void) => {
    action();
    setOpen(false);
    trigger.current?.focus();
  };

  return <div className="note-view-options" ref={root}>
    <button
      ref={trigger}
      className="icon-button note-view-options-trigger"
      aria-label="View options"
      aria-haspopup="menu"
      aria-expanded={open}
      title="View options"
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        setOpen(true);
      }}
    ><SlidersHorizontal aria-hidden="true" /></button>
    {open && <div className="action-menu note-view-options-menu" role="menu" aria-label="Note view options">
      <p className="view-options-heading">Sort</p>
      {noteSortOptions.map((option) => <button
        key={option.value}
        role="menuitemradio"
        aria-checked={sort === option.value}
        onClick={() => select(() => onSort(option.value))}
      ><span className="view-option-check">{sort === option.value && <Check aria-hidden="true" />}</span><span>{option.label}</span></button>)}
      <div className="view-options-divider" role="separator" />
      <p className="view-options-heading">Scope</p>
      {scopeLabel && <button
        role="menuitemradio"
        aria-checked="true"
        title={scopeLabel}
        onClick={() => select(() => undefined)}
      ><span className="view-option-check"><Check aria-hidden="true" /></span><span className="view-option-label">{scopeLabel}</span></button>}
      <button
        role="menuitemradio"
        aria-checked={!scopeLabel}
        onClick={() => select(onClearScope)}
      ><span className="view-option-check">{!scopeLabel && <Check aria-hidden="true" />}</span><span>All notes</span></button>
    </div>}
  </div>;
}
