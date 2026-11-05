import { t } from "@lingui/core/macro";
import { useId, useLayoutEffect, useRef, type JSX, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLocaleRevision } from "./i18n.js";
import { useOverlay } from "./overlay.js";

export function Dialog({ open, onClose, title, descriptionId, className, closeDisabled = false, returnFocusRef, initialFocusRef, role = "dialog", children }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly descriptionId?: string | undefined;
  readonly className?: string | undefined;
  readonly closeDisabled?: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly role?: "dialog" | "alertdialog";
  readonly children: ReactNode;
}): JSX.Element | null {
  useLocaleRevision();
  const { ref, present } = useOverlay<HTMLDialogElement>(open);
  const invoker = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open || dialog.open) return;
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    const focus = () => {
      const scope = initialFocusRef?.current ?? dialog;
      return scope.querySelector<HTMLElement>(initialFocusRef ? 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]' : "[data-autofocus]");
    };
    const first = focus();
    if (first) first.focus({ preventScroll: true });
    else if (initialFocusRef) dialog.focus({ preventScroll: true });
    if (!initialFocusRef || first) return;
    const observer = new MutationObserver(() => {
      if (document.activeElement !== dialog) return;
      const control = focus();
      if (control) { control.focus({ preventScroll: true }); observer.disconnect(); }
    });
    observer.observe(dialog, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, ref, initialFocusRef]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      const wasOpen = dialog?.open;
      dialog?.close();
      if (wasOpen) (returnFocusRef?.current ?? invoker.current)?.focus({ preventScroll: true });
    };
  }, [present, ref, returnFocusRef]);
  if (!present) return null;
  return createPortal(<dialog ref={ref} className={["mdbase-dialog mdbase-overlay", className].filter(Boolean).join(" ")}
    data-open={open} role={role} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); if (!closeDisabled) onClose(); } }}
    onCancel={(event) => { event.preventDefault(); if (!closeDisabled) onClose(); }}
    onClick={(event) => { if (!closeDisabled && event.target === event.currentTarget) onClose(); }}>
    <div className="mdbase-dialog-body">
      <header className="mdbase-dialog-header"><h2 id={titleId}>{title}</h2>
        <button type="button" className="mdbase-icon-button" disabled={closeDisabled} onClick={onClose} aria-label={t({ message: "Close" })}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      {children}
    </div>
  </dialog>, document.body);
}
