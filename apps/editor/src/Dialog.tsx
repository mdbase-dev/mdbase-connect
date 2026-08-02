import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");
const dialogStack: string[] = [];

export function Dialog({ titleId, className, role = "dialog", onClose, children }: {
  titleId: string;
  className: string;
  role?: "dialog" | "alertdialog";
  onClose: () => void;
  children: ReactNode;
}) {
  const closeCallback = useRef(onClose);
  useEffect(() => { closeCallback.current = onClose; }, [onClose]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogStack.push(titleId);
    const appRoot = document.getElementById("root");
    const previousAriaHidden = appRoot?.getAttribute("aria-hidden");
    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute("aria-hidden", "true");
    }

    const dialog = document.querySelector<HTMLElement>(`[aria-labelledby="${titleId}"]`);
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const first = dialog?.querySelector<HTMLElement>("[data-autofocus]") ?? focusable()[0];
    window.requestAnimationFrame(() => first?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== titleId) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeCallback.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items.at(-1)!;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const stackIndex = dialogStack.lastIndexOf(titleId);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      if (appRoot && dialogStack.length === 0) {
        appRoot.inert = false;
        if (previousAriaHidden == null) appRoot.removeAttribute("aria-hidden");
        else appRoot.setAttribute("aria-hidden", previousAriaHidden);
      }
      window.requestAnimationFrame(() => previousFocus?.focus());
    };
  }, [titleId]);

  return createPortal(
    <div className="dialog-scrim" onMouseDown={(event) => {
      if (event.target === event.currentTarget) closeCallback.current();
    }}>
      <section
        className={className}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {children}
      </section>
    </div>,
    document.body
  );
}

export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = "Cancel", tone = "default", initialFocus, onConfirm, onClose }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  initialFocus?: "confirm" | "cancel";
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const titleId = useId();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return <Dialog titleId={titleId} className="confirm-dialog" role="alertdialog" onClose={() => { if (!busy) onClose(); }}>
    <div className="confirm-dialog-copy">
      <h2 id={titleId}>{title}</h2>
      <div>{body}</div>
    </div>
    <footer>
      <button
        data-autofocus={(initialFocus ?? (tone === "danger" ? "cancel" : "confirm")) === "cancel" ? "true" : undefined}
        disabled={busy}
        onClick={onClose}
      >{cancelLabel}</button>
      <button
        className={tone === "danger" ? "confirm-danger" : "confirm-primary"}
        data-autofocus={(initialFocus ?? (tone === "danger" ? "cancel" : "confirm")) === "confirm" ? "true" : undefined}
        disabled={busy}
        onClick={() => void confirm()}
      >{busy ? "Working…" : confirmLabel}</button>
    </footer>
  </Dialog>;
}
