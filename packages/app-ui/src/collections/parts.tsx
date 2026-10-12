import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode, type RefObject } from "react";

import { moveMenuFocus, useMenuPopover } from "../popover.js";
import type { CollectionNotice, CollectionRow, ProblemControl } from "./model.js";
import type { CollectionSectionItem, CollectionSectionItemActionContext, CollectionUi, DeleteCollectionOutcome } from "./use-collection-ui.js";

/** Which row dialog is open, shared by the gate and the switcher. `onClose` hears a delete's outcome. */
export type RowDialog = {
  readonly kind: "forget" | "delete";
  readonly row: Pick<CollectionRow, "id" | "name">;
  readonly onClose?: ((outcome: DeleteCollectionOutcome) => void) | undefined;
} | null;

export type ButtonTone = "primary" | "secondary" | "quiet" | "danger";

/**
 * A text button. While another action runs it stays focusable but inert
 * (`aria-disabled`), and the running one shows its progress label.
 */
export function ActionButton({ tone = "secondary", inert = false, progress, onClick, children, className, ...rest }: {
  readonly tone?: ButtonTone;
  readonly inert?: boolean;
  /** Shown instead of the label while this button's own action runs. */
  readonly progress?: string | null | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly "aria-describedby"?: string | undefined;
}): JSX.Element {
  const label = progress ?? children;
  return <button
    type="button"
    className={["mdbase-collections-button", `is-${tone}`, className].filter(Boolean).join(" ")}
    aria-disabled={inert || progress ? true : undefined}
    onClick={() => { if (!inert && !progress) onClick(); }}
    {...rest}
  >{label}</button>;
}

/** One problem with its own fix: SDK title and message, then the SDK action as a button inside the block. */
export function NoticeBlock({ notice, ui, onSetUp, variant = "block" }: {
  readonly notice: CollectionNotice;
  readonly ui: CollectionUi;
  readonly onSetUp?: (() => void) | undefined;
  readonly variant?: "block" | "banner" | "inline";
}): JSX.Element {
  const control = notice.control && (notice.control.kind !== "set_up" || onSetUp) ? notice.control : null;
  const urgent = !notice.transient && notice.tone !== "info";
  return <div
    className={`mdbase-collections-notice is-${variant}`}
    data-tone={notice.tone}
    role={urgent ? "alert" : "status"}
  >
    <div className="mdbase-collections-notice-copy">
      {notice.title && <p className="mdbase-collections-notice-title">{notice.title}</p>}
      <p className="mdbase-collections-notice-message">{notice.message}</p>
    </div>
    {control && <div className="mdbase-collections-notice-actions">
      <ControlButton control={control} ui={ui} onSetUp={onSetUp} />
    </div>}
  </div>;
}

function ControlButton({ control, ui, onSetUp }: { control: ProblemControl; ui: CollectionUi; onSetUp?: (() => void) | undefined }): JSX.Element {
  if (control.kind === "link") {
    return <a className="mdbase-collections-button is-primary" href={control.href} target="_blank" rel="noopener noreferrer">{control.label}</a>;
  }
  return <ActionButton tone="primary" inert={ui.busy !== null} onClick={() => ui.actions.perform(control, onSetUp)}>{control.label}</ActionButton>;
}

/** Initials on a hue that stays the same for a collection across sessions. */
export function CollectionMark({ row }: { readonly row: Pick<CollectionRow, "id" | "name"> }): JSX.Element {
  return <span className="mdbase-collections-mark" aria-hidden="true" style={{ "--mdbase-collections-hue": hueOf(row.id) } as CSSProperties}>
    {initials(row.name)}
  </span>;
}

/** The name (wrapping, never truncated), the app's optional second line, then one line of role and availability. */
export function RowCopy({ row, ui, detailId, current = row.current }: {
  readonly row: CollectionRow;
  readonly ui: CollectionUi;
  readonly detailId?: string;
  /** Overrides `row.current` (an app section item is open instead). */
  readonly current?: boolean;
}): JSX.Element {
  const meta = [current ? ui.copy.openNow : null, row.roleLabel, row.status].filter(Boolean).join(" · ");
  const secondary = ui.options.rowDetail?.(row);
  return <span className="mdbase-collections-row-copy">
    <span className="mdbase-collections-row-name">
      {row.name}
      {row.disambiguator && <span className="mdbase-collections-row-hint"> {row.disambiguator}</span>}
    </span>
    {secondary && <span className="mdbase-collections-row-secondary">{secondary}</span>}
    <span className="mdbase-collections-row-meta">{meta}</span>
    {row.statusDetail && <span className="mdbase-collections-row-detail" id={detailId}>{row.statusDetail}</span>}
  </span>;
}

/** An app section item: its name and optional second line. */
export function ItemCopy({ item, ui }: { readonly item: CollectionSectionItem; readonly ui: CollectionUi }): JSX.Element {
  return <span className="mdbase-collections-row-copy">
    <span className="mdbase-collections-row-name">{item.name}</span>
    {item.detail && <span className="mdbase-collections-row-secondary">{item.detail}</span>}
    {item.current && <span className="mdbase-collections-row-meta">{ui.copy.openNow}</span>}
  </span>;
}

/** "Remove from this list" and, for owners when allowed, "Delete collection…". */
export function RowMore({ row, ui, onDialog, tabbable = true }: {
  readonly row: CollectionRow;
  readonly ui: CollectionUi;
  readonly onDialog: (dialog: NonNullable<RowDialog>) => void;
  readonly tabbable?: boolean;
}): JSX.Element {
  const canDelete = ui.options.allowDelete === true && row.role === "owner";
  const entries: MenuEntry[] = [{ id: "forget", label: ui.copy.removeFromList, onSelect: () => onDialog({ kind: "forget", row }) }];
  if (canDelete) entries.push({ id: "delete", label: ui.copy.deleteCollection, danger: true, onSelect: () => onDialog({ kind: "delete", row }) });
  return <RowMenuButton label={ui.say("moreFor", { collection: row.name })} entries={entries} tabbable={tabbable} />;
}

/** An app section item's own actions, in the same row menu as an SDK collection's. */
export function ItemMore({ item, ui, onDialog, tabbable = true }: {
  readonly item: CollectionSectionItem;
  readonly ui: CollectionUi;
  readonly onDialog: (dialog: NonNullable<RowDialog>) => void;
  readonly tabbable?: boolean;
}): JSX.Element | null {
  const actions = item.actions ?? [];
  if (actions.length === 0) return null;
  const context: CollectionSectionItemActionContext = {
    confirmDelete: (onClose) => onDialog({ kind: "delete", row: item, onClose }),
  };
  const entries = actions.map((action): MenuEntry => ({
    id: action.id, label: action.label, danger: action.danger, disabled: action.disabled,
    onSelect: () => action.onSelect(item, context),
  }));
  return <RowMenuButton label={ui.say("moreFor", { collection: item.name })} entries={entries} tabbable={tabbable} refocus />;
}

interface MenuEntry {
  readonly id: string;
  readonly label: string;
  readonly danger?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly onSelect: () => void;
}

/**
 * A row's "…" button and its menu. Arrow keys move between enabled entries,
 * Escape closes it and returns focus to the button; with `refocus`, choosing an
 * entry returns focus there too, so a dialog it opens hands focus back to it.
 */
function RowMenuButton({ label, entries, tabbable, refocus = false }: {
  label: string;
  entries: readonly MenuEntry[];
  tabbable: boolean;
  refocus?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = (focus: boolean): void => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  return <>
    <button
      ref={trigger}
      type="button"
      className="mdbase-collections-more"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => setOpen((value) => !value)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
    </button>
    {open && <RowMenu id={menuId} triggerRef={trigger} onClose={close}>
      {entries.map((entry) => <button key={entry.id} type="button" role="menuitem" disabled={entry.disabled}
        className={entry.danger ? "mdbase-collections-menu-item is-danger" : "mdbase-collections-menu-item"}
        onClick={() => { if (entry.disabled) return; close(refocus); entry.onSelect(); }}>
        {entry.label}
      </button>)}
    </RowMenu>}
  </>;
}

function RowMenu({ id, triggerRef, onClose, children }: {
  id: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu, triggerRef, onClose, { align: "end", focus: '[role="menuitem"]' });
  return <div ref={menu} id={id} className="mdbase-collections-menu" popover="manual" role="menu" tabIndex={-1}
    onKeyDown={(event) => moveMenuFocus(event, menu.current)}>{children}</div>;
}

/** The app's actions, Choose a different collection, Manage access, the account and Sign out: never under an error. */
export function GateFooter({ ui, chooseAnother, extra }: { readonly ui: CollectionUi; readonly chooseAnother: boolean; readonly extra?: ReactNode }): JSX.Element | null {
  const { view, copy, busy, actions } = ui;
  const hasExtra = extra !== undefined && extra !== null && extra !== false;
  if (!view.signedIn && !chooseAnother && !hasExtra) return null;
  return <footer className="mdbase-collections-footer">
    {hasExtra && <span className="mdbase-collections-footer-extra">{extra}</span>}
    {chooseAnother && <ActionButton tone="quiet" inert={busy !== null} progress={busy === "choose_another" ? copy.chooseAnother : null}
      onClick={actions.chooseAnother}>{copy.chooseAnother}</ActionButton>}
    {view.signedIn && view.links && <a className="mdbase-collections-link" href={view.links.manageAccess} target="_blank" rel="noopener noreferrer">{copy.manageAccess}</a>}
    {view.signedIn && <AccountLine ui={ui} />}
  </footer>;
}

export function AccountLine({ ui }: { readonly ui: CollectionUi }): JSX.Element {
  const { view, copy, busy, actions, say } = ui;
  return <span className="mdbase-collections-account">
    {view.account && <span className="mdbase-collections-account-label">{say("signedInAs", { account: view.account })}</span>}
    <ActionButton tone="quiet" inert={busy !== null} progress={busy === "sign_out" ? copy.signingOut : null} onClick={actions.signOut}>
      {copy.signOut}
    </ActionButton>
  </span>;
}

/** A native modal <dialog>: the browser traps focus and makes the page inert; Escape cancels. */
export function CollectionDialog({ title, alert = false, busy = false, onClose, children, footer }: {
  readonly title: string;
  readonly alert?: boolean;
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    }
    (dialog?.querySelector<HTMLElement>("[data-autofocus]") ?? dialog?.querySelector<HTMLElement>("button"))?.focus();
    return () => {
      if (dialog?.open && typeof dialog.close === "function") dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog
    ref={ref}
    className="mdbase-collections mdbase-collections-dialog"
    role={alert ? "alertdialog" : undefined}
    aria-labelledby={titleId}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
    }}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
  >
    <h2 id={titleId} className="mdbase-collections-dialog-title">{title}</h2>
    <div className="mdbase-collections-dialog-body">{children}</div>
    <div className="mdbase-collections-dialog-actions">{footer}</div>
  </dialog>;
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/u).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => String.fromCodePoint(word.codePointAt(0) ?? 63));
  return (letters.join("") || "?").toLocaleUpperCase();
}

export function hueOf(id: string): number {
  let hash = 0;
  for (const code of id) hash = (hash * 31 + (code.codePointAt(0) ?? 0)) % 360;
  return hash;
}
