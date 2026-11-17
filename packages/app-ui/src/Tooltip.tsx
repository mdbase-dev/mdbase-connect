import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type JSX,
  type ReactElement,
} from "react";

import { useLocaleRevision } from "./i18n.js";
import { isApplePlatform, shortcutLabel } from "./shortcuts.js";

/** Before a tooltip shows on hover, and before it goes once the pointer has left. */
const SHOW_DELAY_MS = 400;
const HIDE_DELAY_MS = 120;
/** After one tooltip closes, the next opens at once: moving along a toolbar reads each name. */
const WARM_MS = 800;
const GAP = 6;
const MARGIN = 8;

// One tooltip shows at a time, and the warm window spans tooltips, so both are page-wide.
let closeActive: (() => void) | undefined;
let warmUntil = 0;

/** A trigger no one can use or see has no tooltip. */
function available(trigger: HTMLElement): boolean {
  return (
    trigger.isConnected &&
    !trigger.matches(":disabled, [aria-disabled=true]") &&
    !trigger.closest("[hidden], [inert], [aria-hidden=true]") &&
    trigger.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
  );
}

/** Below the trigger and centred on it; above when there is no room below; inside the window. */
function place(bubble: HTMLElement, trigger: HTMLElement): void {
  const anchor = trigger.getBoundingClientRect();
  const size = bubble.getBoundingClientRect();
  const centred = anchor.left + (anchor.width - size.width) / 2;
  const fitsBelow = anchor.bottom + GAP + size.height <= innerHeight - MARGIN;
  const top = fitsBelow ? anchor.bottom + GAP : anchor.top - size.height - GAP;
  const within = (value: number, room: number): number =>
    Math.max(MARGIN, Math.min(value, room - MARGIN));
  bubble.style.left = `${String(within(centred, innerWidth - size.width))}px`;
  bubble.style.top = `${String(within(top, innerHeight - size.height))}px`;
}

function keyShortcuts(shortcut: string): string {
  return shortcut
    .replace(/\bmod\b/giu, isApplePlatform() ? "Meta" : "Control")
    .replace(/\bctrl\b/giu, "Control");
}

/**
 * Names an icon-only control on hover and keyboard focus, with its shortcut when it has one.
 * The label also becomes the control's accessible name unless it already has one. Wrap a
 * single focusable element: a button or a link.
 */
export function Tooltip({
  label,
  shortcut,
  children,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly children: ReactElement<HTMLAttributes<HTMLElement>>;
}): JSX.Element {
  useLocaleRevision();
  const id = useId();
  const trigger = useRef<HTMLElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const stopWatching = useRef<() => void>(undefined);
  const touch = useRef(false);
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    clearTimeout(timer.current);
    stopWatching.current?.();
    if (tooltip.current) warmUntil = performance.now() + WARM_MS;
    if (closeActive === close) closeActive = undefined;
    setOpen(false);
  }, []);
  useEffect(() => close, [close]);

  useLayoutEffect(() => {
    if (!open) return;
    tooltip.current!.showPopover();
    place(tooltip.current!, trigger.current!);
  }, [open, label, shortcut]);

  const show = (element: HTMLElement, delay: boolean): void => {
    if (!available(element)) return;
    closeActive?.();
    closeActive = close;
    trigger.current = element;
    // Anything that takes the trigger away, or the person's attention elsewhere, closes it.
    const controller = new AbortController();
    const { signal } = controller;
    const observer = new MutationObserver(() => {
      if (!available(element)) close();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "hidden", "aria-hidden", "inert", "style", "class", "open"],
    });
    stopWatching.current = () => {
      controller.abort();
      observer.disconnect();
    };
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        // Escape closes a showing tooltip and nothing else; the dialog beneath stays open.
        if (tooltip.current) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        close();
      },
      { capture: true, signal },
    );
    document.addEventListener("pointerdown", close, { capture: true, signal });
    document.addEventListener("scroll", close, { capture: true, signal });
    window.addEventListener("resize", close, { signal });
    window.addEventListener("blur", close, { signal });
    if (delay && performance.now() >= warmUntil) {
      timer.current = setTimeout(() => {
        if (available(element)) setOpen(true);
        else close();
      }, SHOW_DELAY_MS);
    } else {
      setOpen(true);
    }
  };

  // The pointer may cross the gap to the tooltip, so leaving waits a moment.
  const leave = (): void => {
    clearTimeout(timer.current);
    if (tooltip.current) timer.current = setTimeout(close, HIDE_DELAY_MS);
    else close();
  };

  const { props } = children;
  const describedBy = [props["aria-describedby"], open && shortcut ? id : ""].filter(Boolean).join(" ");
  return (
    <>
      {cloneElement(children, {
        "aria-label": props["aria-label"] ?? label,
        "aria-keyshortcuts": shortcut ? keyShortcuts(shortcut) : props["aria-keyshortcuts"],
        "aria-describedby": describedBy || undefined,
        title: undefined,
        onPointerEnter: (event) => {
          if (event.pointerType !== "touch" && matchMedia("(hover: hover)").matches) {
            show(event.currentTarget, true);
          }
          props.onPointerEnter?.(event);
        },
        onPointerLeave: (event) => {
          leave();
          props.onPointerLeave?.(event);
        },
        onPointerDown: (event) => {
          touch.current = event.pointerType === "touch";
          close();
          props.onPointerDown?.(event);
        },
        onFocus: (event) => {
          if (!touch.current && event.currentTarget.matches(":focus-visible")) {
            show(event.currentTarget, false);
          }
          props.onFocus?.(event);
        },
        onBlur: (event) => {
          touch.current = false;
          close();
          props.onBlur?.(event);
        },
        onKeyDown: (event) => {
          touch.current = false;
          if (event.key === "Enter" || event.key === " ") close();
          props.onKeyDown?.(event);
        },
        onClick: (event) => {
          close();
          props.onClick?.(event);
        },
      })}
      {open && (
        <span
          ref={tooltip}
          role="tooltip"
          popover="manual"
          className="mdbase-tooltip"
          onPointerEnter={() => clearTimeout(timer.current)}
          onPointerLeave={leave}
        >
          {label}
          {shortcut && <kbd id={id}>{shortcutLabel(shortcut)}</kbd>}
        </span>
      )}
    </>
  );
}
