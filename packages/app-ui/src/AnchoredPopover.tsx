import { useEffect, useEffectEvent, useLayoutEffect, useRef, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { activeModalDialog, anchoredPlacement } from "./popover.js";

const FOCUSABLE = ':is(button, input, select, textarea, [tabindex="0"]):not(:disabled)';
/** A list that has the keyboard closes on Escape before the popover around it does. */
const OPEN_LIST = '[role="listbox"], [role="menu"]';

export interface AnchoredPopoverProps {
  /** The control that opened the popover: it opens beside it, and a press on it is not a press elsewhere. */
  readonly anchor: RefObject<HTMLElement | null>;
  /** The popover's accessible name. */
  readonly label: string;
  /** Escape (`refocus` is true, and the anchor has the focus again) or a press elsewhere (false). */
  readonly onClose: (refocus: boolean) => void;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

/**
 * A small panel beside the control that opened it, for a value to be chosen or typed: a
 * calendar, a checklist, a short form. Render it while it is wanted. It opens in the top layer,
 * so a scrolling or clipped container does not cut it off, follows its anchor, and puts the
 * keyboard in the element marked `data-autofocus` (failing that, in its first control). Escape
 * closes it and returns the focus to the anchor; a press elsewhere closes it after the field
 * being typed in has lost the focus, so that field can keep what was typed.
 */
export function AnchoredPopover({ anchor, label, onClose, className, children }: AnchoredPopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);
  const place = useEffectEvent(() => {
    const popover = ref.current;
    const trigger = anchor.current;
    if (!popover || !trigger) return;
    const box = trigger.getBoundingClientRect();
    popover.style.maxHeight = "";
    const placement = anchoredPlacement(
      box,
      { width: popover.offsetWidth, height: popover.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { gap: 6 },
    );
    popover.style.top = `${placement.top}px`;
    popover.style.left = `${placement.left}px`;
    popover.style.maxHeight = `${placement.maxHeight}px`;
    popover.style.setProperty("--overlay-origin", `${placement.top < box.top ? "bottom" : "top"} left`);
  });

  useLayoutEffect(() => {
    const popover = ref.current;
    if (!popover) return undefined;
    // Browsers without the Popover API (and jsdom) keep it a fixed element where it is mounted.
    if (typeof popover.showPopover === "function") popover.showPopover();
    place();
    (popover.querySelector<HTMLElement>("[data-autofocus]") ?? popover.querySelector<HTMLElement>(FOCUSABLE))?.focus({ preventScroll: true });
    // Its own content changes size, as a step or a checklist changes.
    const resized = typeof ResizeObserver === "function" ? new ResizeObserver(() => place()) : undefined;
    resized?.observe(popover);
    return () => resized?.disconnect();
  }, []);

  // The anchor moves when the content around it changes.
  useLayoutEffect(() => place());

  useEffect(() => {
    const inside = (target: EventTarget | null): boolean => Boolean(target instanceof Node && ref.current?.contains(target));
    const onPointerDown = (event: PointerEvent): void => {
      if (inside(event.target) || (event.target instanceof Node && anchor.current?.contains(event.target))) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && inside(active)) active.blur();
      close(false);
    };
    const follow = (event: Event): void => {
      if (!inside(event.target)) place();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", follow, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || (event.target as Element).closest(OPEN_LIST)) return;
    event.preventDefault();
    event.stopPropagation();
    anchor.current?.focus({ preventScroll: true });
    onClose(true);
  };

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape reaches the dialog from the fields inside it.
    <div
      ref={ref}
      className={["mdbase-popover mdbase-overlay", className].filter(Boolean).join(" ")}
      data-open
      popover="manual"
      role="dialog"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    activeModalDialog() ?? document.body,
  );
}
