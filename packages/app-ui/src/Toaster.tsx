import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useOverlay } from "./overlay.js";
import { t } from "@lingui/core/macro";
import { i18n, useLocaleRevision } from "./i18n.js";

export interface ToastItem {
  id: string;
  message: string;
  tone?: "info" | "success" | "error";
  action?: { label: string; onAction: () => void; busy?: boolean; dismiss?: boolean };
  sticky?: boolean;
  dismissible?: boolean;
  durationMs?: number;
}

type VisibleToast = ToastItem & { open: boolean };
let queue: VisibleToast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function toast(message: string, undo?: () => void): void {
  const active = queue.filter(item => item.open);
  if (active.length >= 4) active[1].open = false;
  queue.push({ id: `toast-${++nextId}`, message, action: undo ? { label: t(i18n)`Undo`, onAction: undo, dismiss: true } : undefined, durationMs: undo ? 8_000 : 5_000, open: true });
  notify();
}

export function Toaster({ items, onDismiss }: { items?: readonly ToastItem[]; onDismiss?: (id: string) => void }) {
  useLocaleRevision();
  const [queued, setQueued] = useState(() => [...queue]);
  const source = items ?? queued;
  const [previous, setPrevious] = useState(source);
  const [visible, setVisible] = useState<VisibleToast[]>(() => source.map(item => ({ ...item, open: true })));
  if (source !== previous) {
    setPrevious(source);
    setVisible([
      ...source.map(item => ({ ...item, open: "open" in item ? Boolean(item.open) : true })),
      ...visible.filter(item => !source.some(current => current.id === item.id)).map(item => ({ ...item, open: false }))
    ]);
  }
  useEffect(() => {
    const update = () => setQueued([...queue]);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
      void Promise.resolve().then(() => { if (!listeners.size) queue.length = 0; });
    };
  }, []);
  const dismiss = useEffectEvent((id: string) => {
    if (items) onDismiss?.(id);
    else { queue = queue.map(item => item.id === id ? { ...item, open: false } : item); notify(); }
  });
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const item = [...visible].reverse().find(item => item.open && item.dismissible !== false && !item.action?.busy);
      if (item) { event.preventDefault(); dismiss(item.id); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [visible]);
  return <div className="mdbase-toaster" role="status" aria-live="polite" aria-relevant="additions text">
    {visible.map(item => <Toast key={item.id} item={item} onDismiss={() => dismiss(item.id)} onRemoved={() => {
      setVisible(current => current.filter(entry => entry.id !== item.id));
      queue = queue.filter(entry => entry.id !== item.id);
    }} />)}
  </div>;
}
function Toast({ item, onDismiss, onRemoved }: { item: VisibleToast; onDismiss: () => void; onRemoved: () => void }) {
  const { ref, present } = useOverlay<HTMLDivElement>(item.open);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(item.durationMs ?? 6_000);
  const dismiss = useEffectEvent(onDismiss);
  const remove = useEffectEvent(onRemoved);
  useEffect(() => { remaining.current = item.durationMs ?? 6_000; }, [item.message, item.durationMs]);
  useEffect(() => { if (!present) remove(); }, [present]);
  useEffect(() => {
    if (!item.open || item.sticky || item.action?.busy || hovered || focused) return;
    const started = Date.now();
    const timeout = setTimeout(dismiss, remaining.current);
    return () => { clearTimeout(timeout); remaining.current -= Date.now() - started; };
  }, [item.open, item.sticky, item.message, item.durationMs, item.action?.busy, hovered, focused]);
  if (!present) return null;
  return <div ref={ref} data-open={item.open} className="mdbase-toast-slot" inert={!item.open}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className="mdbase-toast-clip"><div className="mdbase-toast" data-tone={item.tone}><span>{item.message}</span>
      {item.action && <button className="mdbase-button is-secondary" disabled={item.action.busy} aria-busy={item.action.busy || undefined} onClick={() => { if (item.action?.dismiss) dismiss(); item.action?.onAction(); }}>{item.action.label}</button>}
      {item.dismissible !== false && <button className="mdbase-button is-tertiary" disabled={item.action?.busy} onClick={dismiss}>{t(i18n)`Dismiss`}</button>}
    </div></div>
  </div>;
}
