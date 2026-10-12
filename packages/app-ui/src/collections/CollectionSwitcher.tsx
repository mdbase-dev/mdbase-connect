import { useId, useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { anchoredPlacement } from "../popover.js";
import { RowDialogs, SignOutDialog } from "./dialogs.js";
import type { CollectionRow } from "./model.js";
import { AccountLine, ActionButton, CollectionMark, ItemCopy, ItemMore, NoticeBlock, RowCopy, RowMore, type RowDialog } from "./parts.js";
import { useCollectionUi, type CollectionSection, type CollectionUi, type CollectionUiOptions } from "./use-collection-ui.js";

/** Collections worth a filter box; fewer fit at a glance. */
const FILTER_THRESHOLD = 7;
const NARROW = "(max-width: 639.98px)";

export interface CollectionSwitcherProps extends CollectionUiOptions {
  /** "full": name and role; "compact": name only; "icon": a glyph for toolbars. */
  readonly variant?: "full" | "compact" | "icon";
  readonly className?: string;
  /**
   * Leading content in the trigger: the app's icon, or "mark" for the open
   * collection's initials. In the "icon" variant it replaces the folder glyph.
   */
  readonly icon?: ReactNode | "mark";
}

/**
 * The in-app collection switcher: a trigger that opens the approved collections
 * (one click switches, no Connect window), "Add a collection…", "Manage access"
 * and the account. A popover on wide screens, a bottom sheet on narrow ones.
 */
export function CollectionSwitcher({ variant = "full", className, icon, ...options }: CollectionSwitcherProps): JSX.Element {
  const ui = useCollectionUi(options);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<RowDialog>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const narrow = useNarrow();
  const { view, copy, say, busy } = ui;
  const app = ui.appOpen?.item ?? null;
  const current = app ? null : view.current;
  const currentName = app?.name ?? current?.name ?? null;
  const name = currentName ?? copy.switchCollectionNone;
  const markOf = app ?? current;
  const leading = icon === "mark" ? (markOf ? <CollectionMark row={markOf} /> : <CollectionsGlyph />) : icon;
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const toDialog = (next: NonNullable<RowDialog>): void => { setOpen(false); setDialog(next); };
  // The popover that held the row is gone: a closed row dialog hands focus to the trigger.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (dialog || !returnFocus.current) return;
    returnFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) trigger.current?.focus();
  }, [dialog]);
  const content = <SwitcherContent ui={ui} onDone={() => close(false)} onDialog={toDialog} />;
  return <span className={["mdbase-collections", "mdbase-collections-switcher", className].filter(Boolean).join(" ")} data-variant={variant}>
    <button
      ref={trigger}
      type="button"
      className="mdbase-collections-trigger"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={currentName ? say("switchCollection", { collection: currentName }) : copy.switchCollectionNone}
      title={name}
      onClick={() => setOpen((value) => !value)}
    >
      {busy === "select" || busy === "add" || view.kind === "opening"
        ? <span className="mdbase-collections-spinner" aria-hidden="true" />
        : leading !== undefined && leading !== null
          ? <span className="mdbase-collections-trigger-icon" aria-hidden="true">{leading}</span>
          : variant === "icon" ? <CollectionsGlyph /> : null}
      {variant !== "icon" && <span className="mdbase-collections-trigger-name">{name}</span>}
      {variant === "full" && current && <span className="mdbase-collections-trigger-role">{current.roleLabel}</span>}
      <svg className="mdbase-collections-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {open && (narrow
      ? <SwitcherSheet id={panelId} ui={ui} onClose={close}>{content}</SwitcherSheet>
      : <SwitcherPopover id={panelId} ui={ui} triggerRef={trigger} onClose={close}>{content}</SwitcherPopover>)}
    <RowDialogs ui={ui} dialog={dialog} onClose={() => { returnFocus.current = true; setDialog(null); }} />
    <SignOutDialog ui={ui} />
  </span>;
}

/** The switcher's list and actions, also shown inline by `CollectionPanel`. */
export function SwitcherContent({ ui, onDone, onDialog }: {
  readonly ui: CollectionUi;
  readonly onDone: () => void;
  /** Open a row's dialog (remove from list, delete), for an SDK collection or an app section item. */
  readonly onDialog: (dialog: NonNullable<RowDialog>) => void;
}): JSX.Element {
  const { view, copy, say, busy, actions } = ui;
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const lists = useRef<HTMLDivElement>(null);
  const listLabel = useId();
  const app = ui.appOpen;
  const sections = (ui.options.sections ?? []).filter((section) => section.items.length > 0 || section.empty);
  const needle = query.trim().toLocaleLowerCase();
  const matches = (name: string): boolean => !needle || name.toLocaleLowerCase().includes(needle);
  const total = view.collections.length + sections.reduce((sum, section) => sum + section.items.length, 0);
  const signIn = view.signedIn ? null : <>
    <p className="mdbase-collections-lead">{say("signedOutLead")}</p>
    <div className="mdbase-collections-actions">
      <ActionButton tone="primary" progress={busy === "sign_in" ? copy.addingCollection : null} inert={busy !== null}
        onClick={() => { actions.signIn(); onDone(); }}>{copy.signIn}</ActionButton>
    </div>
  </>;
  const appSections = sections.map((section) => <SwitcherSection key={section.id} ui={ui} section={section} matches={matches}
    focused={focused} onFocusItem={setFocused} onDone={onDone} onDialog={onDialog} />);
  if (!view.signedIn) {
    return <div className="mdbase-collections-switcher-content">
      {signIn}
      {appSections.length > 0 && <div ref={lists} className="mdbase-collections-switcher-lists" onKeyDown={moveAmongRadios}>{appSections}</div>}
    </div>;
  }
  const rows = view.collections.filter((row) => matches(row.name));
  const isCurrent = (row: CollectionRow): boolean => row.current && !app;
  const sdkKey = (row: CollectionRow): string => `sdk:${row.id}`;
  const rovingId = rows.some((row) => sdkKey(row) === focused) ? focused : (rows.find(isCurrent) ?? rows[0]) ? sdkKey(rows.find(isCurrent) ?? rows[0]!) : null;
  const shown = rows.length + sections.reduce((sum, section) => sum + section.items.filter((item) => matches(item.name)).length, 0);
  return <div className="mdbase-collections-switcher-content">
    <div className="mdbase-collections-switcher-header">
      <span className="mdbase-collections-eyebrow">{copy.collectionLabel}</span>
      {app
        ? <span className="mdbase-collections-switcher-current">
          <strong>{app.item.name}</strong>
          {app.item.detail && <span className="mdbase-collections-row-meta">{app.item.detail}</span>}
        </span>
        : view.current
          ? <span className="mdbase-collections-switcher-current">
            <strong>{view.current.name}</strong>
            <span className="mdbase-collections-chip">{view.current.roleLabel}</span>
            {view.current.status && <span className="mdbase-collections-row-meta">{view.current.status}</span>}
          </span>
          : <span className="mdbase-collections-row-meta">{view.heading}</span>}
    </div>
    {total >= FILTER_THRESHOLD && <input
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
          lists.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
        }
      }}
    />}
    <div ref={lists} className="mdbase-collections-switcher-lists" onKeyDown={moveAmongRadios}>
      {view.collections.length > 0 && <>
        <span id={listLabel} className="mdbase-collections-visually-hidden">{copy.yourCollections}</span>
        <div role="radiogroup" aria-labelledby={listLabel} className="mdbase-collections-switcher-list">
          {rows.map((row) => {
            const detailId = row.statusDetail ? `${listLabel}-${row.id}` : undefined;
            const checked = isCurrent(row);
            return <div key={row.id} className="mdbase-collections-item">
              <button
                type="button"
                role="radio"
                aria-checked={checked}
                aria-disabled={!row.available || undefined}
                aria-describedby={detailId}
                tabIndex={sdkKey(row) === rovingId ? 0 : -1}
                className="mdbase-collections-row"
                onFocus={() => setFocused(sdkKey(row))}
                onClick={() => {
                  if (!row.available || busy !== null) return;
                  actions.select(row.id);
                  onDone();
                }}
              >
                <CollectionMark row={row} />
                <RowCopy row={row} ui={ui} current={checked} {...(detailId ? { detailId } : {})} />
                {checked && <CheckGlyph />}
              </button>
              <RowMore row={row} ui={ui} onDialog={onDialog} tabbable={sdkKey(row) === rovingId} />
            </div>;
          })}
        </div>
      </>}
      {appSections}
      {needle && shown === 0 && <p className="mdbase-collections-empty">{say("noMatches", { query: query.trim() })}</p>}
    </div>
    {ui.error && <NoticeBlock notice={ui.error} ui={ui} variant="inline" />}
    <div className="mdbase-collections-switcher-actions">
      {app && <ActionButton tone="quiet" inert={busy !== null} onClick={() => { actions.chooseAnother(); onDone(); }}>{copy.chooseAnother}</ActionButton>}
      <ActionButton tone="quiet" className="is-add" inert={busy !== null && busy !== "add"} progress={busy === "add" ? copy.addingCollection : null}
        onClick={() => { actions.addCollection(); onDone(); }}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>{copy.addCollection}
      </ActionButton>
      {view.links && <a className="mdbase-collections-link" href={view.links.manageAccess} target="_blank" rel="noopener noreferrer">{copy.manageAccess}</a>}
    </div>
    <div className="mdbase-collections-switcher-footer"><AccountLine ui={ui} /></div>
  </div>;
}

/** One app section as its own labelled radio group. */
function SwitcherSection({ ui, section, matches, focused, onFocusItem, onDone, onDialog }: {
  ui: CollectionUi;
  section: CollectionSection;
  matches: (name: string) => boolean;
  focused: string | null;
  onFocusItem: (key: string) => void;
  onDone: () => void;
  onDialog: (dialog: NonNullable<RowDialog>) => void;
}): JSX.Element | null {
  const label = useId();
  const items = section.items.filter((item) => matches(item.name));
  if (section.items.length > 0 && items.length === 0) return null;
  const key = (id: string): string => `${section.id}:${id}`;
  const roving = items.some((item) => key(item.id) === focused) ? focused : key((items.find((item) => item.current) ?? items[0])?.id ?? "");
  return <div className="mdbase-collections-switcher-section">
    <span id={label} className="mdbase-collections-section-title">{section.title}</span>
    {items.length === 0
      ? <p className="mdbase-collections-empty">{section.empty}</p>
      : <div role="radiogroup" aria-labelledby={label} className="mdbase-collections-switcher-list">
        {items.map((item) => <div key={item.id} className="mdbase-collections-item">
          <button
            type="button"
            role="radio"
            aria-checked={item.current === true}
            aria-disabled={item.disabled || undefined}
            tabIndex={key(item.id) === roving ? 0 : -1}
            className="mdbase-collections-row"
            onFocus={() => onFocusItem(key(item.id))}
            onClick={() => {
              if (item.disabled || ui.busy !== null) return;
              ui.actions.selectItem(section, item);
              onDone();
            }}
          >
            <CollectionMark row={item} />
            <ItemCopy item={item} ui={ui} />
            {item.current && <CheckGlyph />}
          </button>
          <ItemMore item={item} ui={ui} onDialog={onDialog} tabbable={key(item.id) === roving} />
        </div>)}
      </div>}
  </div>;
}

/** Arrow keys within the focused row's radio group; Right and Left between a row and its menu button. */
function moveAmongRadios(event: KeyboardEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement;
  if (event.key === "ArrowRight" && target.getAttribute("role") === "radio") {
    const more = target.parentElement?.querySelector<HTMLElement>(".mdbase-collections-more");
    if (more) { more.focus(); event.preventDefault(); }
    return;
  }
  if (event.key === "ArrowLeft" && target.classList.contains("mdbase-collections-more")) {
    target.parentElement?.querySelector<HTMLElement>('[role="radio"]')?.focus();
    event.preventDefault();
    return;
  }
  const group = target.closest<HTMLElement>('[role="radiogroup"]');
  if (!group || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
  if (radios.length === 0) return;
  event.preventDefault();
  const index = radios.indexOf(target);
  const from = index >= 0 ? index : radios.findIndex((radio) => radio.parentElement?.contains(target));
  const next = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1
    : (from + (event.key === "ArrowDown" ? 1 : -1) + radios.length) % radios.length;
  radios[next]?.focus();
}

/** Where focus starts in the list: the open collection, else the first group's row. */
function firstRadio(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? root.querySelector<HTMLElement>('[role="radio"][tabindex="0"]');
}

function CheckGlyph(): JSX.Element {
  return <svg className="mdbase-collections-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>;
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
    (firstRadio(panel) ?? panel.querySelector<HTMLElement>("button") ?? panel).focus({ preventScroll: true });
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
    firstRadio(sheet)?.focus({ preventScroll: true });
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
