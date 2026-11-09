import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Menu } from "@mdbase-dev/ui/menu";
import { DotsThreeIcon as MoreHorizontal } from "./icons";

export interface ActionMenuItem {
  label: string;
  icon: ReactNode;
  tone?: "default" | "danger";
  disabled?: boolean;
  title?: string;
  separatorBefore?: boolean;
  onSelect: () => void;
}

/** iOS Safari never fires `contextmenu` for a touch long-press, so touch holds
 * open the menu here. Android also fires `contextmenu`; opening twice at the
 * same point is harmless. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

interface MenuPosition {
  left: number;
  top: number;
}

export function ContextMenu({ label, items, children, className = "", style, showTrigger = true }: {
  label: string;
  items: ActionMenuItem[];
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  showTrigger?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const restoreFocus = useRef<HTMLElement | undefined>(undefined);
  const [position, setPosition] = useState<MenuPosition>();
  const press = useRef<{ timer: number; x: number; y: number; opened: boolean } | undefined>(undefined);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    if (!press.current?.opened) press.current = undefined;
  };

  const close = (restore = false) => {
    setPosition(undefined);
    if (restore) restoreFocus.current?.focus();
  };

  const openAt = (left: number, top: number, target?: HTMLElement | null) => {
    restoreFocus.current = target
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined)
      ?? root.current?.querySelector<HTMLElement>(".rail-row-action")
      ?? undefined;
    setPosition({ left, top });
  };

  const openBeside = (target: HTMLElement, focusTarget: HTMLElement | null = target) => {
    const bounds = target.getBoundingClientRect();
    openAt(bounds.right - 4, bounds.bottom + 2, focusTarget);
  };

  return <div
    ref={root}
    className={`context-menu-target ${className}`.trim()}
    style={style}
    onPointerDown={(event) => {
      if (press.current) clearTimeout(press.current.timer);
      press.current = undefined;
      if (event.pointerType !== "touch" || !items.length) return;
      const { clientX: x, clientY: y } = event;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("button") : null;
      press.current = { x, y, opened: false, timer: window.setTimeout(() => {
        if (!press.current) return;
        press.current.opened = true;
        openAt(x, y, target);
      }, LONG_PRESS_MS) };
    }}
    onPointerMove={(event) => {
      const start = press.current;
      if (start && !start.opened && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancelPress();
    }}
    onPointerUp={cancelPress}
    onPointerCancel={cancelPress}
    onClickCapture={(event) => {
      // The tap that ends a long-press opened the menu; it must not also open the row.
      if (!press.current?.opened) return;
      press.current = undefined;
      event.preventDefault();
      event.stopPropagation();
    }}
    onContextMenu={(event) => {
      event.preventDefault();
      const keyboardInvocation = event.clientX === 0 && event.clientY === 0;
      if (keyboardInvocation) {
        openBeside(
          event.currentTarget,
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        );
      } else {
        const focusTarget = event.target instanceof Element
          ? event.target.closest<HTMLElement>("button")
          : null;
        openAt(event.clientX, event.clientY, focusTarget);
      }
    }}
    onKeyDown={(event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      openBeside(
        event.currentTarget,
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      );
    }}
  >
    {children}
    {showTrigger && <button
      ref={trigger}
      className="rail-row-menu"
      tabIndex={-1}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={Boolean(position)}
      onClick={() => position ? close(true) : openBeside(trigger.current!)}
    ><MoreHorizontal aria-hidden="true" /></button>}
    <Menu open={Boolean(position)} id={id} label={label} triggerRef={root} point={position} onClose={close}>
        {items.map((item) => <button
          key={item.label}
          role="menuitem"
          disabled={item.disabled}
          title={item.title}
          className={`mdbase-menu-item${item.tone === "danger" ? " is-danger" : ""}`}
          onClick={() => {
            close();
            item.onSelect();
          }}
        >{item.icon}{item.label}</button>)}
    </Menu>
  </div>;
}
