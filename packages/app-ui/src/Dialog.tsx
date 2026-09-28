import { useLayoutEffect, useRef, type JSX, type ReactNode } from "react";

/**
 * A modal dialog on the native <dialog>: the browser keeps focus inside it and the page
 * behind it inert. Escape, the close button or a press on the backdrop closes it.
 */
export function Dialog({ open, onClose, title, className, children }: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  // A layout effect, so the dialog is open before fields inside it ask to be focused.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog
    ref={ref}
    className={["mdbase-dialog", className].filter(Boolean).join(" ")}
    aria-label={title}
    onClose={onClose}
    onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    {open && <div className="mdbase-dialog-body">
      <header className="mdbase-dialog-header">
        <h2>{title}</h2>
        <button type="button" className="mdbase-icon-button" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </header>
      {children}
    </div>}
  </dialog>;
}
