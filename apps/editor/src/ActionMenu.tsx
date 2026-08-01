import { DotsThreeIcon as MoreHorizontal } from "./icons";
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface ActionMenuItem {
  label: string;
  icon: ReactNode;
  tone?: "default" | "danger";
  onSelect: () => void;
}

export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
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
      const menuItems = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
      const current = menuItems.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const next = (current + direction + menuItems.length) % menuItems.length;
      event.preventDefault();
      menuItems[next]?.focus();
    };
    document.addEventListener("pointerdown", closeForOutsidePress);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePress);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return <div className="note-actions" ref={root}>
    <button
      ref={trigger}
      className="icon-button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        setOpen(true);
      }}
    ><MoreHorizontal aria-hidden="true" /></button>
    {open && <div className="action-menu" role="menu" aria-label={label}>
      {items.map((item) => <button
        key={item.label}
        role="menuitem"
        className={item.tone === "danger" ? "danger-action" : undefined}
        onClick={() => {
          setOpen(false);
          item.onSelect();
          trigger.current?.focus();
        }}
      >{item.icon}{item.label}</button>)}
    </div>}
  </div>;
}
