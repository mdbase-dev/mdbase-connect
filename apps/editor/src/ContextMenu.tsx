import { DotsThreeIcon as MoreHorizontal } from "./icons";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import type { ActionMenuItem } from "./ActionMenu";

interface MenuPosition {
  left: number;
  top: number;
}

const VIEWPORT_MARGIN = 8;

export function ContextMenu({ label, items, children, className = "" }: {
  label: string;
  items: ActionMenuItem[];
  children: ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | undefined>(undefined);
  const [position, setPosition] = useState<MenuPosition>();

  const close = (restore = false) => {
    setPosition(undefined);
    if (restore) requestAnimationFrame(() => restoreFocus.current?.focus());
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

  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const bounds = menu.current.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(position.left, window.innerWidth - bounds.width - VIEWPORT_MARGIN)
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(position.top, window.innerHeight - bounds.height - VIEWPORT_MARGIN)
    );
    if (left !== position.left || top !== position.top) setPosition({ left, top });
  }, [position]);

  useEffect(() => {
    if (!position) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const closeForOutsidePress = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !menu.current?.contains(target)) close();
    };
    const closeForViewportChange = () => close();
    document.addEventListener("pointerdown", closeForOutsidePress);
    window.addEventListener("resize", closeForViewportChange);
    window.addEventListener("scroll", closeForViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePress);
      window.removeEventListener("resize", closeForViewportChange);
      window.removeEventListener("scroll", closeForViewportChange, true);
    };
  }, [position]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close(true);
      return;
    }
    const menuItems = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (!menuItems.length) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      menuItems[event.key === "Home" ? 0 : menuItems.length - 1]?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const current = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const next = (current + direction + menuItems.length) % menuItems.length;
    event.preventDefault();
    menuItems[next]?.focus();
  };

  return <div
    ref={root}
    className={`context-menu-target ${className}`.trim()}
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
    <button
      ref={trigger}
      className="rail-row-menu"
      tabIndex={-1}
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-expanded={Boolean(position)}
      onClick={() => position ? close(true) : openBeside(trigger.current!)}
    ><MoreHorizontal aria-hidden="true" /></button>
    {position && createPortal(
      <div
        ref={menu}
        className="context-menu"
        role="menu"
        aria-label={label}
        style={{ left: position.left, top: position.top }}
        onKeyDown={onMenuKeyDown}
      >
        {items.map((item) => <button
          key={item.label}
          role="menuitem"
          className={item.tone === "danger" ? "danger-action" : undefined}
          onClick={() => {
            close();
            item.onSelect();
          }}
        >{item.icon}{item.label}</button>)}
      </div>,
      document.body
    )}
  </div>;
}
