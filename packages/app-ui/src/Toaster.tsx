import { t } from "@lingui/core/macro";
import { useEffect, useEffectEvent, useRef, useState, type JSX } from "react";

import { i18n, useLocaleRevision } from "./i18n.js";
import { useOverlay } from "./overlay.js";

export interface ToastItem {
  id: string;
  message: string;
  /** success and error put a mark before the message; info (the default) has none. */
  tone?: "info" | "success" | "error";
  action?: { label: string; onAction: () => void; busy?: boolean; dismiss?: boolean };
  /** Stays until dismissed. */
  sticky?: boolean;
  dismissible?: boolean;
  durationMs?: number;
}

/** Everything a toast can carry except its text and the id `toast` gives it. */
export type ToastOptions = Omit<ToastItem, "id" | "message">;

type VisibleToast = ToastItem & { open: boolean };

const MAX_OPEN = 4;
/** How long a toast from `toast` stays: a plain receipt, and one with an action to reach. */
const RECEIPT_MS = 5_000;
const ACTION_MS = 8_000;
/** An app-owned item that names no duration. */
const ITEM_MS = 6_000;

let queue: VisibleToast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const notify = (): void => listeners.forEach((listener) => listener());

function close(id: string): void {
  queue = queue.map((item) => (item.id === id ? { ...item, open: false } : item));
  notify();
}

/**
 * Shows a toast in the page's `<Toaster />` and returns a function that dismisses it.
 * Pass a function for the common receipt with Undo, or options for anything else:
 *
 *     toast("Renamed", () => rename(before));
 *     toast("Could not save", { tone: "error", sticky: true });
 */
export function toast(message: string, undo?: () => void): () => void;
export function toast(message: string, options: ToastOptions): () => void;
export function toast(message: string, options?: ToastOptions | (() => void)): () => void {
  const given: ToastOptions =
    typeof options === "function"
      ? { action: { label: t(i18n)`Undo`, onAction: options, dismiss: true } }
      : (options ?? {});
  const open = queue.filter((item) => item.open);
  // The oldest toast stays, so the first receipt of a burst is never lost to the rest.
  if (open.length >= MAX_OPEN) open[1]!.open = false;
  const id = `toast-${String(++nextId)}`;
  queue.push({
    durationMs: given.action ? ACTION_MS : RECEIPT_MS,
    ...given,
    id,
    message,
    open: true,
  });
  notify();
  return () => close(id);
}

/**
 * Where toasts appear. Render one per page. With no props it shows what `toast` queues; with
 * `items` the app owns the list and hears about dismissals through `onDismiss`.
 */
export function Toaster({
  items,
  onDismiss,
}: {
  items?: readonly ToastItem[];
  onDismiss?: (id: string) => void;
}): JSX.Element {
  useLocaleRevision();
  const [queued, setQueued] = useState(() => [...queue]);
  const source = items ?? queued;
  const [previous, setPrevious] = useState(source);
  const [visible, setVisible] = useState<VisibleToast[]>(() =>
    source.map((item) => ({ ...item, open: true })),
  );
  if (source !== previous) {
    setPrevious(source);
    // A toast that left the source stays, closed, until its exit has played.
    setVisible([
      ...source.map((item) => ({ ...item, open: "open" in item ? Boolean(item.open) : true })),
      ...visible
        .filter((item) => !source.some((current) => current.id === item.id))
        .map((item) => ({ ...item, open: false })),
    ]);
  }
  useEffect(() => {
    const update = (): void => setQueued([...queue]);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
      // StrictMode replays this effect; only a Toaster that is really gone clears the queue.
      void Promise.resolve().then(() => {
        if (!listeners.size) queue.length = 0;
      });
    };
  }, []);
  const dismiss = useEffectEvent((id: string) => {
    if (items) onDismiss?.(id);
    else close(id);
  });
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape belongs to an open dialog or menu before it belongs to a toast.
      if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"]')) {
        return;
      }
      const item = [...visible]
        .reverse()
        .find((item) => item.open && item.dismissible !== false && !item.action?.busy);
      if (item) {
        event.preventDefault();
        dismiss(item.id);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [visible]);
  return (
    <div className="mdbase-toaster" role="status" aria-live="polite" aria-relevant="additions text">
      {visible.map((item) => (
        <Toast
          key={item.id}
          item={item}
          onDismiss={() => dismiss(item.id)}
          onRemoved={() => {
            setVisible((current) => current.filter((entry) => entry.id !== item.id));
            queue = queue.filter((entry) => entry.id !== item.id);
          }}
        />
      ))}
    </div>
  );
}

const tonePaths = {
  success: "m3.5 8.5 3 3 6-7",
  error: "M8 4.5v4.5M8 11.5v.01",
} as const;

function Toast({
  item,
  onDismiss,
  onRemoved,
}: {
  item: VisibleToast;
  onDismiss: () => void;
  onRemoved: () => void;
}): JSX.Element | null {
  const { ref, present } = useOverlay<HTMLDivElement>(item.open);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(item.durationMs ?? ITEM_MS);
  const dismiss = useEffectEvent(onDismiss);
  const remove = useEffectEvent(onRemoved);
  useEffect(() => {
    remaining.current = item.durationMs ?? ITEM_MS;
  }, [item.message, item.durationMs]);
  useEffect(() => {
    if (!present) remove();
  }, [present]);
  // The clock stops while the toast is hovered, focused or working, and resumes where it was.
  useEffect(() => {
    if (!item.open || item.sticky || item.action?.busy || hovered || focused) return;
    const started = Date.now();
    const timeout = setTimeout(dismiss, remaining.current);
    return () => {
      clearTimeout(timeout);
      remaining.current -= Date.now() - started;
    };
  }, [item.open, item.sticky, item.message, item.durationMs, item.action?.busy, hovered, focused]);
  if (!present) return null;
  const { action } = item;
  const tonePath = item.tone && item.tone !== "info" ? tonePaths[item.tone] : undefined;
  return (
    <div
      ref={ref}
      data-open={item.open}
      className="mdbase-toast-slot"
      inert={!item.open}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <div className="mdbase-toast-clip">
        <div className="mdbase-toast" data-tone={item.tone}>
          {tonePath && (
            <svg className="mdbase-toast-tone" viewBox="0 0 16 16" aria-hidden="true">
              <path d={tonePath} pathLength={1} />
            </svg>
          )}
          <span className="mdbase-toast-message">{item.message}</span>
          {action && (
            <button
              type="button"
              className="mdbase-button"
              disabled={action.busy}
              aria-busy={action.busy || undefined}
              onClick={() => {
                if (action.dismiss) dismiss();
                action.onAction();
              }}
            >
              {action.label}
            </button>
          )}
          {item.dismissible !== false && (
            <button
              type="button"
              className="mdbase-icon-button"
              aria-label={t(i18n)`Dismiss`}
              disabled={action?.busy}
              onClick={dismiss}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              >
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
