import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactElement } from "react";
import { useLocaleRevision } from "./i18n.js";
import { isApplePlatform, shortcutLabel } from "./shortcuts.js";

let activeTooltip: (() => void) | undefined;
let warmUntil = 0;

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
  const dispose = useRef<() => void>(undefined);
  const touch = useRef(false);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    clearTimeout(timer.current);
    dispose.current?.();
    if (tooltip.current) warmUntil = performance.now() + 800;
    if (activeTooltip === close) activeTooltip = undefined;
    setOpen(false);
  }, []);
  useEffect(() => close, [close]);
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
    const available = () => button.isConnected && !button.matches(":disabled, [aria-disabled=true]") && !button.closest("[hidden], [inert], [aria-hidden=true]") && button.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
    if (!available()) return;
    activeTooltip?.();
    activeTooltip = close;
    trigger.current = button;
    const controller = new AbortController();
    const observer = new MutationObserver(() => { if (!available()) close(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "hidden", "aria-hidden", "inert", "style", "class", "open"] });
    dispose.current = () => { controller.abort(); observer.disconnect(); };
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (tooltip.current) { event.preventDefault(); event.stopImmediatePropagation(); }
      close();
    }, { capture: true, signal: controller.signal });
    document.addEventListener("pointerdown", close, { capture: true, signal: controller.signal });
    document.addEventListener("scroll", close, { capture: true, signal: controller.signal });
    window.addEventListener("resize", close, { signal: controller.signal });
    window.addEventListener("blur", close, { signal: controller.signal });
    if (delay && performance.now() >= warmUntil) timer.current = setTimeout(() => { if (available()) setOpen(true); else close(); }, 400);
    else setOpen(true);
  };
  const leave = () => { clearTimeout(timer.current); if (tooltip.current) timer.current = setTimeout(close, 120); else close(); };
  return <>{cloneElement(children, {
    "aria-label": children.props["aria-label"] ?? label,
    "aria-keyshortcuts": shortcut ? shortcut.replace(/\bmod\b/giu, isApplePlatform() ? "Meta" : "Control").replace(/\bctrl\b/giu, "Control") : children.props["aria-keyshortcuts"],
    "aria-describedby": [children.props["aria-describedby"], open && shortcut ? id : ""].filter(Boolean).join(" ") || undefined,
    title: undefined,
    onPointerEnter: event => { if (event.pointerType !== "touch" && matchMedia("(hover: hover)").matches) show(event.currentTarget, true); children.props.onPointerEnter?.(event); },
    onPointerLeave: event => { leave(); children.props.onPointerLeave?.(event); },
    onPointerDown: event => { touch.current = event.pointerType === "touch"; close(); children.props.onPointerDown?.(event); },
    onFocus: event => { if (!touch.current && event.currentTarget.matches(":focus-visible")) show(event.currentTarget, false); children.props.onFocus?.(event); },
    onBlur: event => { touch.current = false; close(); children.props.onBlur?.(event); },
    onKeyDown: event => { touch.current = false; if (event.key === "Enter" || event.key === " ") close(); children.props.onKeyDown?.(event); },
    onClick: event => { close(); children.props.onClick?.(event); }
  })}{open && <span ref={tooltip} role="tooltip" popover="manual" className="mdbase-tooltip" onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}>{label}{shortcut && <kbd id={id}>{shortcutLabel(shortcut)}</kbd>}</span>}</>;
}
