import { useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { moveMenuFocus, useMenuPopover } from "./popover.js";
import { useOverlay } from "./overlay.js";

export function Menu({ open, triggerRef, onClose, id, label, className = "mdbase-menu", children, point }: {
  readonly open: boolean;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onClose: (refocus: boolean) => void;
  readonly id: string;
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly point?: { readonly left: number; readonly top: number } | undefined;
}) {
  const { ref, present } = useOverlay<HTMLDivElement>(open);
  useMenuPopover(ref, triggerRef, onClose, { align: "end", open, point });
  return present ? <div ref={ref} id={id} className={`${className} mdbase-overlay`} data-open={open}
    popover="manual" role="menu" aria-label={label} tabIndex={-1}
    onKeyDown={(event) => moveMenuFocus(event, ref.current)}
    onPointerMove={focusMenuItemUnderPointer}>{children}</div> : null;
}

/** Hovering a row takes focus from the keyboard-marked one, unless a field in the menu is being typed in. */
function focusMenuItemUnderPointer(event: PointerEvent<HTMLElement>) {
  const menu = event.currentTarget;
  if (event.pointerType !== "mouse" || (document.activeElement instanceof HTMLInputElement && menu.contains(document.activeElement))) return;
  const item = (event.target as Element).closest<HTMLElement>('[role^="menuitem"]:not(:disabled):not([aria-disabled="true"])');
  if (item && menu.contains(item) && item !== document.activeElement) item.focus({ preventScroll: true });
}

export function useMenuTrigger() {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  return { id, open, close, trigger, triggerProps: {
    ref: trigger,
    "aria-haspopup": "menu" as const,
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    onClick: () => setOpen(value => !value),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
    }
  } };
}
