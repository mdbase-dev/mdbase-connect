import { useEffect, useRef, useState } from "react";
import { useOverlay } from "./overlay.js";
import { t } from "@lingui/core/macro";
import { i18n, useLocaleRevision } from "./i18n.js";

type Toast = { id: number; message: string; undo?: () => void; open: boolean };
let queue: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function toast(message: string, undo?: () => void): void {
  const active = queue.filter(item => item.open);
  if (active.length >= 4) active[1].open = false;
  queue.push({ id: ++nextId, message, undo, open: true });
  notify();
}

export function Toaster() {
  useLocaleRevision();
  const [items, setItems] = useState(() => [...queue]);
  useEffect(() => {
    const update = () => setItems([...queue]);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
      void Promise.resolve().then(() => { if (!listeners.size) queue.length = 0; });
    };
  }, []);
  return <div className="mdbase-toaster" role="status" aria-live="polite" aria-relevant="additions text">
    {items.map(item => <ToastItem key={item.id} item={item} />)}
  </div>;
}

function ToastItem({ item }: { item: Toast }) {
  const { ref, present } = useOverlay<HTMLDivElement>(item.open);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(item.undo ? 8_000 : 5_000);
  useEffect(() => {
    if (!present) { queue = queue.filter(current => current !== item); notify(); }
  }, [present, item]);
  const dismiss = () => { item.open = false; notify(); };
  useEffect(() => {
    if (!item.open || hovered || focused) return;
    const started = Date.now();
    const timeout = setTimeout(dismiss, remaining.current);
    return () => { clearTimeout(timeout); remaining.current -= Date.now() - started; };
  }, [item.open, hovered, focused]);
  if (!present) return null;
  return <div ref={ref} data-open={item.open} className="mdbase-toast-slot" inert={!item.open}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className="mdbase-toast-clip"><div className="mdbase-toast"><span>{item.message}</span>
      {item.undo && <button className="mdbase-button is-secondary" onClick={() => { dismiss(); item.undo?.(); }}>{t(i18n)`Undo`}</button>}
      <button className="mdbase-button is-tertiary" onClick={dismiss}>{t(i18n)`Dismiss`}</button>
    </div></div>
  </div>;
}
