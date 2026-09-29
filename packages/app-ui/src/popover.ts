import { useEffect, useEffectEvent, useLayoutEffect, type KeyboardEvent, type RefObject } from "react";

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Where a popover opens beside its trigger: below when it fits, otherwise on whichever side
 * has more room, lined up with the trigger's start (or end) edge and kept inside the viewport.
 */
export function anchoredPlacement(
  trigger: Box,
  popover: Size,
  viewport: Size,
  { gap = 4, margin = 8, align = "start" }: { gap?: number; margin?: number; align?: "start" | "end" } = {}
): { readonly top: number; readonly left: number; readonly maxHeight: number } {
  const below = viewport.height - trigger.bottom - gap - margin;
  const above = trigger.top - gap - margin;
  const opensUp = popover.height > below && above > below;
  const room = Math.max(120, opensUp ? above : below);
  const height = Math.min(popover.height, room);
  const width = Math.max(popover.width, trigger.width);
  const start = align === "end" ? trigger.left + trigger.width - width : trigger.left;
  return {
    top: opensUp ? trigger.top - gap - height : trigger.bottom + gap,
    left: Math.max(margin, Math.min(start, viewport.width - width - margin)),
    maxHeight: room
  };
}

function place(
  trigger: HTMLElement,
  popover: HTMLElement,
  options: { gap?: number; align?: "start" | "end"; matchWidth: boolean }
): void {
  const box = trigger.getBoundingClientRect();
  if (options.matchWidth) popover.style.minWidth = `${box.width}px`;
  popover.style.maxHeight = "";
  const placement = anchoredPlacement(
    box,
    { width: popover.offsetWidth, height: popover.scrollHeight },
    { width: window.innerWidth, height: window.innerHeight },
    options
  );
  popover.style.top = `${placement.top}px`;
  popover.style.left = `${placement.left}px`;
  popover.style.maxHeight = `${placement.maxHeight}px`;
}

// Browsers without the Popover API (and jsdom) keep the element in place instead.
function showInTopLayer(element: HTMLElement): void {
  if (typeof element.showPopover === "function") element.showPopover();
}

function hideFromTopLayer(element: HTMLElement): void {
  if (typeof element.hidePopover === "function" && element.matches(":popover-open")) element.hidePopover();
}

function onScreen(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.bottom > 0 && box.top < window.innerHeight
    && box.right > 0 && box.left < window.innerWidth;
}

/**
 * Shows a select's list in the top layer beside its trigger, focuses it, and dismisses it when
 * the pointer lands elsewhere or the page scrolls or resizes underneath it.
 */
export function useSelectPopover(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
  onDismiss: () => void
): void {
  const dismiss = useEffectEvent(onDismiss);
  useLayoutEffect(() => {
    const list = listRef.current;
    const trigger = triggerRef.current;
    if (!open || !list || !trigger) return undefined;
    showInTopLayer(list);
    place(trigger, list, { matchWidth: true });
    list.focus({ preventScroll: true });
    return () => {
      hideFromTopLayer(list);
    };
  }, [open, triggerRef, listRef]);
  useEffect(() => {
    const list = listRef.current;
    const trigger = triggerRef.current;
    if (!open || !list || !trigger) return undefined;
    const outside = (event: Event): void => {
      const target = event.target as Node | null;
      if (target && !list.contains(target) && !trigger.contains(target)) dismiss();
    };
    // Content under the list can move (a panel scrolls, a list re-renders): the list follows
    // its trigger, and closes only once the trigger has left the screen.
    const follow = (event: Event): void => {
      if (list.contains(event.target as Node | null)) return;
      if (onScreen(trigger)) place(trigger, list, { matchWidth: true });
      else dismiss();
    };
    const onResize = (): void => dismiss();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", follow, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, triggerRef, listRef]);
}

export interface MenuPopoverOptions {
  /** Preferred width; narrow viewports shrink it. Omit it to leave the width to CSS. */
  readonly width?: number | undefined;
  /** Which edge of the trigger the menu lines up with. */
  readonly align?: "start" | "end" | undefined;
  /** Element focused when the menu opens; the menu itself when nothing matches. */
  readonly focus?: string | undefined;
  /** While true, outside presses, Escape and Tab leave the menu open (an action is running). */
  readonly busy?: boolean | undefined;
}

/**
 * Keeps a mounted menu in the top layer beside its trigger. It closes on an outside press,
 * Escape (returning focus to the trigger), Tab or a resize.
 */
export function useMenuPopover(
  menuRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  onClose: (refocus: boolean) => void,
  { width, align = "start", focus = '[aria-checked="true"], [role^="menuitem"]', busy = false }: MenuPopoverOptions
): void {
  const close = useEffectEvent(onClose);
  const locked = useEffectEvent(() => busy);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return undefined;
    showInTopLayer(menu);
    if (width !== undefined) menu.style.width = `${Math.min(width, window.innerWidth - 16)}px`;
    place(trigger, menu, { gap: 6, align, matchWidth: false });
    (menu.querySelector<HTMLElement>(focus) ?? menu).focus({ preventScroll: true });
    return () => {
      hideFromTopLayer(menu);
    };
  }, [menuRef, triggerRef, width, align, focus]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && !locked() && !menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        close(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if ((event.key === "Escape" || event.key === "Tab") && !locked()) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
        close(event.key === "Escape");
      }
    };
    const onResize = (): void => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [menuRef, triggerRef]);
}

/**
 * Arrow keys, Home and End move between a menu's enabled items. From a text field inside the
 * menu (a filter), Home and End stay in the field and the arrows enter the list.
 */
export function moveMenuFocus(event: KeyboardEvent, menu: HTMLElement | null): void {
  if (!menu || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')];
  const inField = document.activeElement instanceof HTMLInputElement && menu.contains(document.activeElement);
  if (inField && (event.key === "Home" || event.key === "End")) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : inField
        ? 0
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus({ preventScroll: true });
}
