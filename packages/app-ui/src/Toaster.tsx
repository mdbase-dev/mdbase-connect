import { useEffect, useRef, useState } from "react";
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
    {current && <div key={current.id} className="mdbase-toast"><span>{current.message}</span>
      {current.undo && <button onClick={() => { dismiss(); current.undo?.(); }}>{t(i18n)`Undo`}</button>}
      <button onClick={dismiss}>{t(i18n)`Dismiss`}</button>
    </div>}
  </div>;
}
