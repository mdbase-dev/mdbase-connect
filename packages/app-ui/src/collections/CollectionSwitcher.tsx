import { useId, useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { anchoredPlacement } from "../popover.js";
import { RowDialogs, SignOutDialog, type RowDialog } from "./dialogs.js";
import type { CollectionRow } from "./model.js";
import { AccountLine, ActionButton, CollectionMark, NoticeBlock, RowCopy, RowMore } from "./parts.js";
import { useCollectionUi, type CollectionUi, type CollectionUiOptions } from "./use-collection-ui.js";

/** Collections worth a filter box; fewer fit at a glance. */
const FILTER_THRESHOLD = 7;
const NARROW = "(max-width: 639.98px)";

export interface CollectionSwitcherProps extends CollectionUiOptions {
  /** "full": name and role; "compact": name only; "icon": a glyph for toolbars. */
  readonly variant?: "full" | "compact" | "icon";
  readonly className?: string;
}

/**
 * The in-app collection switcher: a trigger that opens the approved collections
 * (one click switches, no Connect window), "Add a collection…", "Manage access"
 * and the account. A popover on wide screens, a bottom sheet on narrow ones.
 */
export function CollectionSwitcher({ variant = "full", className, ...options }: CollectionSwitcherProps): JSX.Element {
  const ui = useCollectionUi(options);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<RowDialog>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const narrow = useNarrow();
  const { view, copy, say, busy } = ui;
  const current = view.current;
  const name = current?.name ?? copy.switchCollectionNone;
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const toDialog = (kind: "forget" | "delete") => (row: CollectionRow) => { setOpen(false); setDialog({ kind, row }); };
  const content = <SwitcherContent ui={ui} onDone={() => close(false)} onForget={toDialog("forget")} onDelete={toDialog("delete")} />;
  return <span className={["mdbase-collections", "mdbase-collections-switcher", className].filter(Boolean).join(" ")} data-variant={variant}>
    <button
      ref={trigger}
      type="button"
      className="mdbase-collections-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={current ? say("switchCollection", { collection: current.name }) : copy.switchCollectionNone}
      title={name}
      onClick={() => setOpen((value) => !value)}
    >
      {busy === "select" || busy === "add" || view.kind === "opening"
        ? <span className="mdbase-collections-spinner" aria-hidden="true" />
        : variant === "icon" ? <CollectionsGlyph /> : null}
      {variant !== "icon" && <span className="mdbase-collections-trigger-name">{name}</span>}
      {variant === "full" && current && <span className="mdbase-collections-trigger-role">{current.roleLabel}</span>}
      <svg className="mdbase-collections-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && (narrow
      ? <SwitcherSheet id={panelId} ui={ui} onClose={close}>{content}</SwitcherSheet>
      : <SwitcherPopover id={panelId} ui={ui} triggerRef={trigger} onClose={close}>{content}</SwitcherPopover>)}
    <RowDialogs ui={ui} dialog={dialog} onClose={() => setDialog(null)} />
    <SignOutDialog ui={ui} />
  </span>;
}

/** The switcher's list and actions, also shown inline by `CollectionPanel`. */
export function SwitcherContent({ ui, onDone, onForget, onDelete }: {
  readonly ui: CollectionUi;
  readonly onDone: () => void;
  readonly onForget: (row: CollectionRow) => void;
  readonly onDelete: (row: CollectionRow) => void;
}): JSX.Element {
  const { view, copy, say, busy, actions } = ui;
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const group = useRef<HTMLDivElement>(null);
  const listLabel = useId();
  if (!view.signedIn) {
    return <div className="mdbase-collections-switcher-content">
      <p className="mdbase-collections-lead">{say("signedOutLead")}</p>
      <div className="mdbase-collections-actions">
        <ActionButton tone="primary" progress={busy === "sign_in" ? copy.addingCollection : null} inert={busy !== null}
          onClick={() => { actions.signIn(); onDone(); }}>{copy.signIn}</ActionButton>
      </div>
    </div>;
  }
  const needle = query.trim().toLocaleLowerCase();
  const rows = needle ? view.collections.filter((row) => row.name.toLocaleLowerCase().includes(needle)) : view.collections;
  const rovingId = rows.some((row) => row.id === focused) ? focused : (rows.find((row) => row.current) ?? rows[0])?.id ?? null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const radios = [...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const target = event.target as HTMLElement;
    const index = radios.indexOf(target);
    if (event.key === "ArrowRight" && index >= 0) {
      target.parentElement?.querySelector<HTMLElement>(".mdbase-collections-more")?.focus();
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowLeft" && target.classList.contains("mdbase-collections-more")) {
      target.parentElement?.querySelector<HTMLElement>('[role="radio"]')?.focus();
      event.preventDefault();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || radios.length === 0) return;
    event.preventDefault();
    const from = index >= 0 ? index : radios.findIndex((radio) => radio.parentElement?.contains(target));
    const next = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1
      : (from + (event.key === "ArrowDown" ? 1 : -1) + radios.length) % radios.length;
    radios[next]?.focus();
  };
  return <div className="mdbase-collections-switcher-content">
    <div className="mdbase-collections-switcher-header">
      <span className="mdbase-collections-eyebrow">{copy.collectionLabel}</span>
      {view.current
        ? <span className="mdbase-collections-switcher-current">
          <strong>{view.current.name}</strong>
          <span className="mdbase-collections-chip">{view.current.roleLabel}</span>
          {view.current.status && <span className="mdbase-collections-row-meta">{view.current.status}</span>}
        </span>
        : <span className="mdbase-collections-row-meta">{view.heading}</span>}
    </div>
    {view.collections.length >= FILTER_THRESHOLD && <input
      className="mdbase-collections-field mdbase-collections-filter"
      type="search"
      inputMode="search"
      aria-label={copy.findCollection}
      placeholder={copy.findCollection}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          group.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
        }
      }}
    />}
    {view.collections.length > 0 && <>
      <span id={listLabel} className="mdbase-collections-visually-hidden">{copy.yourCollections}</span>
      <div ref={group} role="radiogroup" aria-labelledby={listLabel} className="mdbase-collections-switcher-list" onKeyDown={onKeyDown}>
        {rows.map((row) => {
          const detailId = row.statusDetail ? `${listLabel}-${row.id}` : undefined;
          return <div key={row.id} className="mdbase-collections-item">
            <button
              type="button"
              role="radio"
              aria-checked={row.current}
              aria-disabled={!row.available || undefined}
              aria-describedby={detailId}
              tabIndex={row.id === rovingId ? 0 : -1}
              className="mdbase-collections-row"
              onFocus={() => setFocused(row.id)}
              onClick={() => {
                if (!row.available || busy !== null) return;
                actions.select(row.id);
                onDone();
              }}
            >
              <CollectionMark row={row} />
              <RowCopy row={row} ui={ui} {...(detailId ? { detailId } : {})} />
              {row.current && <svg className="mdbase-collections-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>}
            </button>
            <RowMore row={row} ui={ui} onForget={onForget} onDelete={onDelete} tabbable={row.id === rovingId} />
          </div>;
        })}
        {rows.length === 0 && <p className="mdbase-collections-empty">{say("noMatches", { query: query.trim() })}</p>}
      </div>
    </>}
    {ui.error && <NoticeBlock notice={ui.error} ui={ui} variant="inline" />}
    <div className="mdbase-collections-switcher-actions">
      <ActionButton tone="quiet" className="is-add" inert={busy !== null && busy !== "add"} progress={busy === "add" ? copy.addingCollection : null}
        onClick={() => { actions.addCollection(); onDone(); }}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>{copy.addCollection}
      </ActionButton>
      {view.links && <a className="mdbase-collections-link" href={view.links.manageAccess} target="_blank" rel="noopener noreferrer">{copy.manageAccess}</a>}
    </div>
    <div className="mdbase-collections-switcher-footer"><AccountLine ui={ui} /></div>
  </div>;
}

/** Wide screens: a non-modal dialog anchored to the trigger, in the top layer where supported. */
function SwitcherPopover({ id, ui, triggerRef, onClose, children }: {
  id: string;
  ui: CollectionUi;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const panel = ref.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return undefined;
    if (typeof panel.showPopover === "function") panel.showPopover();
    const box = trigger.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    panel.style.width = `${width}px`;
    const place = anchoredPlacement(box, { width, height: panel.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }, { gap: 6 });
    panel.style.top = `${place.top}px`;
    panel.style.left = `${place.left}px`;
    panel.style.maxHeight = `${place.maxHeight}px`;
    (panel.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ?? panel.querySelector<HTMLElement>("button") ?? panel).focus({ preventScroll: true });
    return () => {
      if (typeof panel.hidePopover === "function" && panel.matches(":popover-open")) panel.hidePopover();
    };
  }, [triggerRef]);
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && !ref.current?.contains(target) && !triggerRef.current?.contains(target)) closeRef.current(false);
    };
    const resize = (): void => closeRef.current(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", resize);
    };
  }, [triggerRef]);
  return <div
    ref={ref}
    id={id}
    className="mdbase-collections-popover"
    popover="manual"
    role="dialog"
    aria-label={ui.copy.collectionsLabel}
    tabIndex={-1}
    onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    }}
    onBlur={(event) => {
      const next = event.relatedTarget as Node | null;
      if (next && !ref.current?.contains(next) && !triggerRef.current?.contains(next)) onClose(false);
    }}
  >{children}</div>;
}

/** Narrow screens: a modal bottom sheet on the native <dialog>. */
function SwitcherSheet({ id, ui, onClose, children }: { id: string; ui: CollectionUi; onClose: (refocus: boolean) => void; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const sheet = ref.current;
    if (!sheet) return undefined;
    if (!sheet.open) {
      if (typeof sheet.showModal === "function") sheet.showModal(); else sheet.setAttribute("open", "");
    }
    sheet.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus({ preventScroll: true });
    return () => { if (sheet.open && typeof sheet.close === "function") sheet.close(); };
  }, []);
  return <dialog
    ref={ref}
    id={id}
    className="mdbase-collections mdbase-collections-sheet"
    aria-label={ui.copy.collectionsLabel}
    onCancel={(event) => { event.preventDefault(); onClose(true); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(true); }}
  >
    <div className="mdbase-collections-sheet-body">
    <div className="mdbase-collections-sheet-header">
      <span className="mdbase-collections-sheet-title">{ui.copy.collectionsLabel}</span>
      <button type="button" className="mdbase-collections-more" aria-label={ui.copy.close} onClick={() => onClose(true)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
    {children}
    </div>
  </dialog>;
}

function CollectionsGlyph(): JSX.Element {
  return <svg className="mdbase-collections-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11z" /></svg>;
}

function subscribeNarrow(listener: () => void): () => void {
  const query = typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : null;
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, () => typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches, () => false);
}
