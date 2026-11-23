import { useId, useLayoutEffect, type JSX, type ReactNode, type RefObject } from "react";

import { Glyph } from "../glyphs.js";
import { Menu } from "../Menu.js";

export type FilterMenuItem =
  | { label: string; hint?: string | undefined; icon?: ReactNode; checked?: boolean; danger?: boolean; onSelect: () => void }
  | "separator";

/**
 * One of the bar's menus: the shared menu beside the pill segment that opened it. Rows with
 * `checked` set are a single choice; the menu opens on the chosen one.
 */
export function FilterMenu({ open, anchor, label, items, onClose }: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  items: FilterMenuItem[];
  /** `refocus` is true after Escape: the anchor takes the focus back. */
  onClose: (refocus: boolean) => void;
}): JSX.Element {
  const id = useId();
  // The shared menu opens on its first row; a single choice opens on the row that is chosen.
  useLayoutEffect(() => {
    if (open) document.getElementById(id)?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus({ preventScroll: true });
  }, [open, id]);
  return (
    <Menu open={open} id={id} label={label} className="mdbase-menu mdbase-filter-menu" triggerRef={anchor} align="start"
      onClose={(refocus) => { if (refocus) anchor.current?.focus({ preventScroll: true }); onClose(refocus); }}>
      {items.map((item, index) => item === "separator" ? <div key={`separator-${String(index)}`} className="mdbase-menu-divider" role="separator" /> : (
        <button key={item.label} type="button" className={item.danger ? "mdbase-menu-item is-danger" : "mdbase-menu-item"}
          role={item.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={item.checked} onClick={item.onSelect}>
          {item.icon}
          <span className="mdbase-filter-menu-label">{item.label}</span>
          {item.hint && <span className="mdbase-filter-hint">{item.hint}</span>}
          {item.checked && <span className="mdbase-filter-menu-check"><Glyph name="check" size={12} /></span>}
        </button>
      ))}
    </Menu>
  );
}
