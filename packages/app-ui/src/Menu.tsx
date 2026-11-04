import type { ReactNode, RefObject } from "react";
import { moveMenuFocus, useMenuPopover } from "./popover.js";
import { useOverlay } from "./overlay.js";

export function Menu({ open, triggerRef, onClose, id, label, className = "mdbase-menu", children }: {
  readonly open: boolean;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly onClose: (refocus: boolean) => void;
  readonly id: string;
  readonly label?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const { ref, present } = useOverlay<HTMLDivElement>(open);
  useMenuPopover(ref, triggerRef, onClose, { align: "end", open });
  return present ? <div ref={ref} id={id} className={`${className} mdbase-overlay`} data-open={open}
    popover="manual" role="menu" aria-label={label} tabIndex={-1}
    onKeyDown={(event) => moveMenuFocus(event, ref.current)}>{children}</div> : null;
}
