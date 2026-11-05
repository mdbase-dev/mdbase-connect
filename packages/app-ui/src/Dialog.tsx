import { t } from "@lingui/core/macro";
import { useLayoutEffect, useRef, type JSX, type ReactNode, type RefObject } from "react";
import { useLocaleRevision } from "./i18n.js";
import { useOverlay } from "./overlay.js";

export function Dialog({ open, onClose, title, className, closeDisabled = false, returnFocusRef, children }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly className?: string | undefined;
  readonly closeDisabled?: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly children: ReactNode;
}): JSX.Element | null {
  useLocaleRevision();
  const { ref, present } = useOverlay<HTMLDialogElement>(open);
  const invoker = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open || dialog.open) return;
    const previous = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (previous && previous !== dialog) {
      previous.dispatchEvent(new Event("cancel", { cancelable: true }));
      previous.close();
    }
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [open, ref]);
  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      const wasOpen = dialog?.open;
      dialog?.close();
      if (wasOpen && !document.querySelector("dialog[open]")) (returnFocusRef?.current ?? invoker.current)?.focus({ preventScroll: true });
    };
  }, [present, ref, returnFocusRef]);
  if (!present) return null;
  return <dialog ref={ref} className={["mdbase-dialog mdbase-overlay", className].filter(Boolean).join(" ")}
    data-open={open} role="dialog" aria-label={title}
    onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); if (!closeDisabled) onClose(); } }}
    onCancel={(event) => { event.preventDefault(); if (!closeDisabled) onClose(); }}
    onMouseDown={(event) => { if (!closeDisabled && event.target === event.currentTarget) onClose(); }}>
    <div className="mdbase-dialog-body">
      <header className="mdbase-dialog-header"><h2>{title}</h2>
        <button type="button" className="mdbase-icon-button" disabled={closeDisabled} onClick={onClose} aria-label={t({ message: "Close" })}>
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>
      {children}
    </div>
  </dialog>;
}
