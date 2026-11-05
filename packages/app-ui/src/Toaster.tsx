import { useEffect, useRef, useState } from "react";
import { useOverlay } from "./overlay.js";
import { t } from "@lingui/core/macro";
import { i18n, useLocaleRevision } from "./i18n.js";

type Toast = { id: number; message: string; undo?: () => void };
const queue: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

export function toast(message: string, undo?: () => void): void {
  if (queue.length >= 4) queue.splice(1, 1);
  queue.push({ id: ++nextId, message, undo });
  notify();
}

export function Toaster() {
  useLocaleRevision();
  const [current, setCurrent] = useState<Toast | undefined>(queue[0]);
  const last = useRef(current);
  if (current) last.current = current;
  const { ref, present } = useOverlay<HTMLDivElement>(Boolean(current));
  const shown = current ?? last.current;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(0);
  useEffect(() => { remaining.current = current?.undo ? 8_000 : 5_000; }, [current]);
  useEffect(() => {
    const update = () => setCurrent(queue[0]);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
      void Promise.resolve().then(() => { if (!listeners.size) queue.length = 0; });
    };
  }, []);
  const dismiss = () => { setFocused(false); queue.shift(); notify(); };
  useEffect(() => {
    if (!current || hovered || focused) return;
    const started = Date.now();
    const timeout = setTimeout(dismiss, remaining.current);
    return () => { clearTimeout(timeout); remaining.current -= Date.now() - started; };
  }, [current, hovered, focused]);
  return <div className="mdbase-toaster" role="status" aria-live="polite" aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    {present && shown && <div ref={ref} data-open={Boolean(current)} className="mdbase-toast mdbase-overlay"><span>{shown.message}</span>
      {shown.undo && <button className="mdbase-button is-secondary" onClick={() => { dismiss(); shown.undo?.(); }}>{t(i18n)`Undo`}</button>}
      <button className="mdbase-button is-tertiary" onClick={dismiss}>{t(i18n)`Dismiss`}</button>
    </div>}
  </div>;
}
