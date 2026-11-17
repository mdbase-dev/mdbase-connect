import { t } from "@lingui/core/macro";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useLocaleRevision } from "./i18n.js";
import { useOverlay } from "./overlay.js";
import { Tooltip } from "./Tooltip.js";

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly descriptionId?: string | undefined;
  readonly className?: string | undefined;
  /** While true, Escape, the backdrop and the close button do nothing (an action is running). */
  readonly closeDisabled?: boolean;
  /** Where focus goes on close; the element focused when the dialog opened otherwise. */
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  /** A region whose first control takes focus on open, in place of `[data-autofocus]`. */
  readonly initialFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly role?: "dialog" | "alertdialog";
  readonly children: ReactNode;
}

/**
 * A modal dialog: a native `<dialog>` in the top layer, with a title and a close button. It
 * closes on Escape, a press on the backdrop or the close button, and hands focus back to
 * where it came from.
 */
export function Dialog({
  open,
  onClose,
  title,
  descriptionId,
  className,
  closeDisabled = false,
  returnFocusRef,
  initialFocusRef,
  role = "dialog",
  children,
}: DialogProps): JSX.Element | null {
  useLocaleRevision();
  const { ref, present } = useOverlay<HTMLDialogElement>(open);
  const invoker = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const returnFocus = (): void => {
    (returnFocusRef?.current ?? invoker.current)?.focus({ preventScroll: true });
  };

  // Open: show the dialog and focus its first control. A region named by initialFocusRef may
  // render its controls late, so the dialog holds focus until one arrives.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open || dialog.open) return;
    invoker.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    const firstControl = (): HTMLElement | null =>
      initialFocusRef
        ? (initialFocusRef.current ?? dialog).querySelector<HTMLElement>(FOCUSABLE)
        : dialog.querySelector<HTMLElement>("[data-autofocus]");
    const first = firstControl();
    if (first) first.focus({ preventScroll: true });
    else if (initialFocusRef) dialog.focus({ preventScroll: true });
    if (!initialFocusRef || first) return;
    const observer = new MutationObserver(() => {
      if (document.activeElement !== dialog) return;
      const control = firstControl();
      if (control) {
        control.focus({ preventScroll: true });
        observer.disconnect();
      }
    });
    observer.observe(dialog, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, ref, initialFocusRef]);

  // A running action disables the control that had focus; the dialog holds it until the
  // action ends, then gives it back to the autofocus control.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const active = document.activeElement;
    if (closeDisabled && (!dialog.contains(active) || active?.matches(":disabled"))) {
      dialog.focus({ preventScroll: true });
    }
    if (!closeDisabled && active === dialog) {
      dialog
        .querySelector<HTMLElement>("[data-autofocus]:not(:disabled)")
        ?.focus({ preventScroll: true });
    }
  }, [closeDisabled, open, ref]);

  // Close: the dialog stays mounted while it leaves, but gives focus back at once.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (open || !dialog) return;
    const ownedFocus = dialog.contains(document.activeElement) || document.activeElement === document.body;
    if (dialog.open) dialog.close();
    if (ownedFocus) returnFocus();
  }, [open, ref, returnFocusRef]);

  // Unmounted while open (its owner went away): close and return focus all the same.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      const wasOpen = dialog?.open;
      dialog?.close();
      if (wasOpen) returnFocus();
    };
  }, [present, ref, returnFocusRef]);

  if (!present) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    // An exiting dialog no longer owns the keyboard, so app shortcuts still work.
    if (open) event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (!closeDisabled) onClose();
    }
    // While closing is disabled, Tab cycles through the controls that are still enabled.
    if (event.key === "Tab" && closeDisabled) {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(`${FOCUSABLE}, a[href]`)]
        .filter((control) => control.getClientRects().length > 0);
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      const next =
        current < 0
          ? event.shiftKey ? controls.length - 1 : 0
          : (current + step + controls.length) % controls.length;
      event.preventDefault();
      (controls[next] ?? event.currentTarget).focus({ preventScroll: true });
    }
  };

  return createPortal(
    <dialog
      ref={ref}
      className={["mdbase-dialog mdbase-overlay", className].filter(Boolean).join(" ")}
      data-open={open}
      inert={!open}
      aria-hidden={!open || undefined}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
      // A press on the backdrop lands on the dialog element itself; it closes the dialog
      // without moving focus first.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
      onClick={(event) => {
        if (!closeDisabled && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="mdbase-dialog-body">
        <header className="mdbase-dialog-header">
          <h2 id={titleId}>{title}</h2>
          <Tooltip label={t({ message: "Close" })} shortcut="Escape">
            <button type="button" className="mdbase-icon-button" disabled={closeDisabled} onClick={onClose}>
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
          </Tooltip>
        </header>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
