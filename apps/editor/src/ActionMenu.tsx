import { DotsThreeIcon as MoreHorizontal } from "./icons";
import { moveMenuFocus, useMenuPopover } from "@mdbase-dev/ui/popover";
import { Fragment, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";

export interface ActionMenuItem {
  label: string;
  icon: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  title?: string;
  separatorBefore?: boolean;
  onSelect: () => void;
}

/**
 * A menu dropped from a trigger button, lined up with its end edge. It sits in the top
 * layer, so scrolling panels never clip it.
 */
export function MenuPopover({ label, className, triggerRef, onClose, children }: {
  label: string;
  className?: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu, triggerRef, onClose, {
    align: "end",
    focus: '[aria-checked="true"], [role^="menuitem"]:not(:disabled)'
  });
  return <div
    ref={menu}
    className={className ? `action-menu mdbase-popover ${className}` : "action-menu mdbase-popover"}
    popover="manual"
    role="menu"
    aria-label={label}
    tabIndex={-1}
    onKeyDown={(event) => {
      moveMenuFocus(event, menu.current);
      if (event.defaultPrevented && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && menu.current?.contains(focused)) {
          focused.scrollIntoView?.({ block: "nearest" });
        }
      }
    }}
  >{children}</div>;
}

/** Open state for a menu trigger: closing can return focus to the trigger. */
export function useMenuTrigger() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const triggerProps = {
    ref: trigger,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    onClick: () => setOpen((value) => !value),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      setOpen(true);
    }
  };
  return { open, close, trigger, triggerProps };
}

export function ActionMenu({ label, items }: { label: string; items: ActionMenuItem[] }) {
  const { open, close, trigger, triggerProps } = useMenuTrigger();
  return <div className="note-actions">
    <button {...triggerProps} className="icon-button" aria-label={label}><MoreHorizontal aria-hidden="true" /></button>
    {open && <MenuPopover label={label} triggerRef={trigger} onClose={close}>
      {items.map((item) => <Fragment key={item.label}>
        {item.separatorBefore && <div role="separator" className="action-menu-separator" />}
        <button
        role="menuitem"
        className={item.tone === "danger" ? "danger-action" : undefined}
        disabled={item.disabled}
        title={item.title}
        onClick={() => {
          close(true);
          item.onSelect();
        }}
      >{item.icon}{item.label}</button></Fragment>)}
    </MenuPopover>}
  </div>;
}
