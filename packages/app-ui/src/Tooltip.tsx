import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactElement } from "react";
import { useLocaleRevision } from "./i18n.js";
import { isApplePlatform, shortcutLabel } from "./shortcuts.js";

let activeTooltip: (() => void) | undefined;
let warmUntil = 0;
function dismissOnEscape(event: KeyboardEvent) { if (event.key === "Escape") activeTooltip?.(); }
function dismissOnPress() { activeTooltip?.(); }

export function Tooltip({ label, shortcut, children }: {
  readonly label: string;
  readonly shortcut?: string;
  readonly children: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
}) {
  useLocaleRevision();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const touch = useRef(false);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    if (tooltip.current) warmUntil = performance.now() + 800;
    if (activeTooltip === close) {
      activeTooltip = undefined;
      document.removeEventListener("keydown", dismissOnEscape, true);
      document.removeEventListener("pointerdown", dismissOnPress, true);
    }
    setOpen(false);
  }, []);
  useEffect(() => close, [close]);
  useEffect(() => {
    if (!open) return;
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [open, close]);
  useLayoutEffect(() => {
    if (!open) return;
    const bubble = tooltip.current!;
    bubble.showPopover();
    const button = trigger.current!.getBoundingClientRect();
    const bounds = bubble.getBoundingClientRect();
    bubble.style.left = `${Math.max(8, Math.min(button.left + (button.width - bounds.width) / 2, innerWidth - bounds.width - 8))}px`;
    bubble.style.top = `${Math.max(8, Math.min(button.bottom + 6 + bounds.height <= innerHeight - 8 ? button.bottom + 6 : button.top - bounds.height - 6, innerHeight - bounds.height - 8))}px`;
  }, [open, label, shortcut]);
  const show = (button: HTMLButtonElement, delay: boolean) => {
    if (button.disabled) return;
    activeTooltip?.();
    activeTooltip = close;
    trigger.current = button;
    document.addEventListener("keydown", dismissOnEscape, true);
    document.addEventListener("pointerdown", dismissOnPress, true);
    if (delay && performance.now() >= warmUntil) timer.current = setTimeout(() => setOpen(true), 400);
    else setOpen(true);
  };
  return <>{cloneElement(children, {
    "aria-label": label,
    "aria-keyshortcuts": shortcut ? shortcut.replace(/\bmod\b/giu, isApplePlatform() ? "Meta" : "Control").replace(/\bctrl\b/giu, "Control") : children.props["aria-keyshortcuts"],
    "aria-describedby": [children.props["aria-describedby"], open ? id : ""].filter(Boolean).join(" ") || undefined,
    title: undefined,
    onPointerEnter: event => { if (event.pointerType !== "touch" && matchMedia("(hover: hover)").matches) show(event.currentTarget, true); children.props.onPointerEnter?.(event); },
    onPointerLeave: event => { close(); children.props.onPointerLeave?.(event); },
    onPointerDown: event => { touch.current = event.pointerType === "touch"; close(); children.props.onPointerDown?.(event); },
    onFocus: event => { if (!touch.current && event.currentTarget.matches(":focus-visible")) show(event.currentTarget, false); children.props.onFocus?.(event); },
    onBlur: event => { touch.current = false; close(); children.props.onBlur?.(event); },
    onKeyDown: event => { touch.current = false; if (event.key === "Enter" || event.key === " ") close(); children.props.onKeyDown?.(event); },
    onClick: event => { close(); children.props.onClick?.(event); }
  })}{open && <span ref={tooltip} id={id} role="tooltip" popover="manual" className="mdbase-tooltip">{label}{shortcut && <kbd>{shortcutLabel(shortcut)}</kbd>}</span>}</>;
}
