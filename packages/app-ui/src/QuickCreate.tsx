import { t } from "@lingui/core/macro";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
} from "react";

import { useLocaleRevision } from "./i18n.js";
import { anchoredPlacement } from "./popover.js";

const FOCUSABLE = ':is(button, input, select, textarea, [tabindex="0"]):not(:disabled)';
const OPEN_LIST = '[aria-expanded="true"], [role="listbox"], [role="menu"]';

export interface QuickCreateProps {
  /** What is being made ("New book"): the heading and the form's accessible name. */
  readonly title: string;
  readonly icon?: ReactNode;
  readonly name: string;
  /** The name field's accessible name and placeholder. */
  readonly nameLabel: string;
  readonly onNameChange: (name: string) => void;
  /** Where on screen the record is being made from; nothing once that place has gone. */
  readonly anchor: () => DOMRect | undefined;
  readonly submitLabel: string;
  readonly cancelLabel?: string | undefined;
  /** Why the form cannot be submitted yet. The submit button is disabled and says so. */
  readonly blocker?: string | undefined;
  readonly onSubmit: () => void;
  /** `refocus` is false when a press elsewhere has already moved the focus. */
  readonly onClose: (refocus: boolean) => void;
  readonly className?: string | undefined;
  /** The fields the record needs besides its name. */
  readonly children?: ReactNode;
}

/**
 * A short form for a record made in passing, beside the place it is made from: its name, then
 * the fields the app asks for. It opens in the top layer and takes the keyboard until it is
 * submitted or dismissed. Escape and Cancel dismiss it, as does a press anywhere else. Render it
 * while the form is wanted; the app closes it by no longer rendering it.
 */
export function QuickCreate({
  title,
  icon,
  name,
  nameLabel,
  onNameChange,
  anchor,
  submitLabel,
  cancelLabel = t({ message: "Cancel" }),
  blocker,
  onSubmit,
  onClose,
  className,
  children,
}: QuickCreateProps): JSX.Element {
  useLocaleRevision();
  const ref = useRef<HTMLDivElement>(null);
  const fields = useRef<HTMLDivElement>(null);
  const place = useEffectEvent(() => {
    const popover = ref.current;
    const box = anchor();
    if (!popover || !box) return;
    popover.style.maxHeight = "";
    const placement = anchoredPlacement(
      box,
      { width: popover.offsetWidth, height: popover.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { gap: 6 },
    );
    popover.style.top = `${placement.top}px`;
    popover.style.left = `${placement.left}px`;
    popover.style.maxHeight = `${placement.maxHeight}px`;
    popover.style.setProperty(
      "--overlay-origin",
      `${placement.top < box.top ? "bottom" : "top"} left`,
    );
  });
  const close = useEffectEvent(onClose);

  useLayoutEffect(() => {
    const popover = ref.current;
    if (!popover) return undefined;
    if (typeof popover.showPopover === "function") popover.showPopover();
    place();
    // The name is usually typed already: the first field still to fill in takes the keyboard.
    const first =
      fields.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      popover.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus({ preventScroll: true });
    // The form grows as lists gain items and errors appear.
    const resized = new ResizeObserver(() => place());
    resized.observe(popover);
    return () => resized.disconnect();
  }, []);

  useEffect(() => {
    const inside = (target: EventTarget | null) =>
      Boolean(target instanceof Node && ref.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) close(false);
    };
    const onScroll = (event: Event) => {
      if (!inside(event.target)) place();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const popover = ref.current;
      if (!popover) return;
      if (event.key === "Escape") {
        // A list open inside the form (a choice, a link picker) closes first.
        if (inside(event.target) && (event.target as Element).closest(OPEN_LIST)) return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === "Tab") {
        // Tab stays in the form: behind it is the page the record is being made from.
        const controls = [...popover.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const edge = event.shiftKey ? controls[0] : controls.at(-1);
        const active = document.activeElement;
        if (!controls.length || (inside(active) && active !== edge)) return;
        event.preventDefault();
        (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", place);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`mdbase-quick-create mdbase-overlay${className ? ` ${className}` : ""}`}
      data-open
      popover="manual"
      role="dialog"
      aria-label={title}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocker) onSubmit();
        }}
      >
        <header className="mdbase-quick-create-header">
          <span className="mdbase-quick-create-title">
            {icon}
            {title}
          </span>
          <input
            className="mdbase-quick-create-name"
            aria-label={nameLabel}
            placeholder={nameLabel}
            value={name}
            autoComplete="off"
            onChange={(event) => onNameChange(event.target.value)}
          />
        </header>
        {children !== undefined && children !== null && (
          <div ref={fields} className="mdbase-quick-create-fields">
            {children}
          </div>
        )}
        <footer className="mdbase-quick-create-actions">
          <button type="button" className="mdbase-button is-tertiary" onClick={() => onClose(true)}>
            {cancelLabel}
          </button>
          <button
            type="submit"
            className="mdbase-button is-primary"
            disabled={Boolean(blocker)}
            title={blocker}
          >
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
