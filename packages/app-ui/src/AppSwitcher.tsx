import { t } from "@lingui/core/macro";
import { useLocaleRevision } from "./i18n.js";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import {
  aiAssistants,
  mcpSetupUrl,
  mdbaseAppHref,
  officialApps,
  withAppUrls,
  type MdbaseAppId,
  type OfficialApp,
  type OfficialAppId
} from "./apps.js";
import { MdbaseAppMark, Wordmark, type MdbaseMarkMotion } from "./brand.js";
import { useMdbaseMarkActivity } from "./mark-activity.js";
import { Menu } from "./Menu.js";
import { moveMenuFocus, placeSubmenu } from "./popover.js";

/** Where the menu's "Your app here" row goes: the same SDK guide in every environment. */
const sdkDocumentationUrl = "https://mdbase.dev/sdk/";

function isMdbaseAppId(id: OfficialAppId): id is MdbaseAppId {
  return id === "editor" || id === "reader" || id === "writer";
}

export type AppSwitcherProps = {
  readonly current: OfficialAppId;
  /** Lab and local builds, for example `{ writer: import.meta.env.VITE_MDBASE_WRITER_URL }`. */
  readonly urls?: Partial<Record<OfficialApp["id"], string | undefined>>;
  /**
   * Setup guide for other AI clients using MCP, the last row of the AI assistants submenu.
   * Pass `null` on custom servers to omit the submenu: the assistants' listings use mdbase's own.
   */
  readonly mcpUrl?: string | null | undefined;
  /** Current collection ID for apps that do not carry `?collection=` in `location.href`. */
  readonly collectionId?: string | null | undefined;
  /** Which edge of the trigger (or anchor) the menu aligns to. Defaults to `"start"`. */
  readonly align?: "start" | "end" | undefined;
  /**
   * Whether the menu is open. Leave it out and the switcher keeps its own
   * state; pass it and the switcher only asks through `onOpenChange`.
   */
  readonly open?: boolean | undefined;
  /** Called whenever the switcher opens or closes itself, controlled or not. */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
} & ({
  /** "wordmark": the product wordmark opens the menu; "none": no trigger. */
  readonly variant?: "wordmark" | undefined;
  readonly motion?: MdbaseMarkMotion | undefined;
  readonly className?: string | undefined;
  /** Custom trigger content (mark and name) for apps with their own identity, such as TaskNotes. */
  readonly children?: ReactNode;
  readonly anchorRef?: never;
} | {
  /**
   * No trigger of its own: the app opens the menu with `open` and `onOpenChange`,
   * for instance from an item in its own overflow menu while its wordmark is hidden.
   */
  readonly variant: "none";
  /**
   * The app's element the menu belongs to, such as the button of the menu that
   * offered it. The menu is placed against it and focus returns to it on Escape.
   * It must stay mounted while the menu is open.
   */
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly motion?: never;
  readonly className?: never;
  readonly children?: never;
});

/**
 * The product wordmark as a menu for opening the current collection in the other mdbase apps.
 * Each opens in a new tab so the current app stays where it is.
 *
 * Its mark shows the page's activity (see `mark-activity`): progress, then a held loop,
 * then `motion`. Without a `motion` it plays `keys-first` the first time it appears.
 *
 * Pass `open` and `onOpenChange` to control it. With `variant="none"` it has no
 * trigger, so an app can open it from its own control and pass that control's
 * element (or the menu button that held it) as `anchorRef`.
 */
export function AppSwitcher({
  current,
  urls = {},
  mcpUrl = mcpSetupUrl,
  motion,
  collectionId,
  className,
  align = "start",
  open: openProp,
  onOpenChange,
  variant = "wordmark",
  anchorRef,
  children
}: AppSwitcherProps): JSX.Element {
  useLocaleRevision();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchor = anchorRef ?? triggerRef;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = (next: boolean): void => {
    if (next === open) return;
    if (openProp === undefined) setOwnOpen(next);
    onOpenChange?.(next);
  };
  const activity = useMdbaseMarkActivity();
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) anchor.current?.focus();
  };
  const triggerContent = children ?? (isMdbaseAppId(current)
    ? <Wordmark app={current} motion={activity.busy ?? motion ?? "keys-first"} signal={activity.signal} progress={activity.progress} />
    : <span className="wordmark">
      <MdbaseAppMark app={current} className="wordmark-mark" />
      <span className="wordmark-label"><span>{officialApps.find((app) => app.id === current)?.name ?? current}</span></span>
    </span>);
  return <>
    {variant !== "none" && <button
      ref={triggerRef}
      type="button"
      className={className ? `mdbase-app-switcher ${className}` : "mdbase-app-switcher"}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      title={t({ message: "Open in another mdbase app" })}
      onClick={() => (open ? close(false) : setOpen(true))}
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      {triggerContent}
      <svg className="mdbase-app-switcher-chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m7 10 5 5 5-5" />
      </svg>
    </button>}
    <Menu open={open} id={menuId} triggerRef={anchor} onClose={close} label={t({ message: "mdbase apps" })} align={align}>
      <AppMenu apps={withAppUrls(urls, officialApps)} current={current} collectionId={collectionId} mcpUrl={mcpUrl} onClose={close} />
    </Menu>
  </>;
}

function AppMenu({ apps, current, collectionId, mcpUrl, onClose }: {
  readonly apps: readonly OfficialApp[];
  readonly current: OfficialAppId;
  readonly collectionId?: string | null | undefined;
  readonly mcpUrl: string | null;
  readonly onClose: (refocus: boolean) => void;
}): JSX.Element {
  useLocaleRevision();
  const hasCollection = Boolean(collectionId) || new URL(location.href).searchParams.has("collection");
  const heading = hasCollection ? t({ message: "Open this collection in" }) : t({ message: "mdbase apps" });
  return <>
    <div className="mdbase-menu-heading" role="presentation">{heading}</div>
    <div className="mdbase-menu-list">
      {apps.map((app) => <AppItem key={app.id} app={app} current={app.id === current} collectionId={collectionId} onOpen={() => onClose(false)} />)}
      <BuildYourOwnItem onOpen={() => onClose(false)} />
    </div>
    {mcpUrl && <>
      <div className="mdbase-menu-divider" role="separator" />
      <div className="mdbase-menu-list">
        <AiAssistantsItem setupUrl={mcpUrl} onClose={onClose} />
      </div>
    </>}
    <div className="mdbase-menu-note">{t({ message: "Opens in a new tab" })}</div>
  </>;
}

function ExternalIcon(): JSX.Element {
  return <svg className="mdbase-app-menu-external" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 5.5H5.5v13h13V14M13.5 5.5h5v5M18.5 5.5 11 13" />
  </svg>;
}

function NewTabHint(): JSX.Element {
  return <span className="mdbase-visually-hidden">  {t({ message: "(opens in a new tab)" })}</span>;
}

/** The marks the "Your app here" slot spins past before it lands on an empty, waiting tile. */
const reel: readonly OfficialAppId[] = [...officialApps.map((app) => app.id), "editor", "reader", "writer"];

/** An empty slot after the apps, for the app someone builds next. */
function BuildYourOwnItem({ onOpen }: { readonly onOpen: () => void }): JSX.Element {
  useLocaleRevision();
  return <a className="mdbase-menu-item mdbase-app-menu-build" role="menuitem" href={sdkDocumentationUrl} target="_blank" rel="noopener" onClick={onOpen}>
    <span className="mdbase-app-menu-slot" aria-hidden="true">
      <span className="mdbase-app-menu-reel" style={{ "--reel-stops": reel.length + 1 } as CSSProperties}>
        <span className="mdbase-app-menu-slot-plus" />
        {reel.map((id, index) => <MdbaseAppMark key={index} app={id} />)}
        <span className="mdbase-app-menu-slot-caret" />
      </span>
    </span>
    <span className="mdbase-menu-copy">
      <strong>{t({ message: "Your app here", context: "App switcher" })}</strong>
      <small>{t({ message: "Build one with the mdbase SDK", context: "App switcher" })}</small>
    </span>
    <ExternalIcon />
    <NewTabHint />
  </a>;
}

function McpMark(): JSX.Element {
  return <svg className="mdbase-app-menu-mark mdbase-app-menu-mcp-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="6.5" cy="12" r="2.25" />
    <circle cx="17.5" cy="6.5" r="2.25" />
    <circle cx="17.5" cy="17.5" r="2.25" />
    <path d="M8.5 11 15.5 7.5M8.5 13l7 3.5" />
  </svg>;
}

/** How long the pointer may be off the row and its submenu before the submenu closes. */
const submenuCloseDelay = 250;

/**
 * A row that opens a submenu of the AI assistants with an official mdbase listing, then the
 * MCP setup guide for any other client. The pointer opens it by hovering; a click, Enter, Space
 * or → opens it and enters it; ← or leaving it closes it.
 */
function AiAssistantsItem({ setupUrl, onClose }: {
  readonly setupUrl: string;
  readonly onClose: (refocus: boolean) => void;
}): JSX.Element {
  useLocaleRevision();
  const submenuId = useId();
  const rowRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const enter = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const show = (enterSubmenu: boolean): void => {
    clearTimeout(closeTimer.current);
    enter.current = enterSubmenu;
    setOpen(true);
    if (enterSubmenu && open) submenuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  };
  const hide = (refocus: boolean): void => {
    clearTimeout(closeTimer.current);
    setOpen(false);
    if (refocus) rowRef.current?.focus();
  };
  const hideSoon = (): void => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), submenuCloseDelay);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const submenu = submenuRef.current;
    if (!open || !row || !submenu) return;
    placeSubmenu(row, submenu);
    if (enter.current) submenu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [open]);
  const onSubmenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      hide(true);
    } else moveMenuFocus(event, submenuRef.current);
    // The parent menu's own arrow keys would leave the submenu.
    if (["ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) event.stopPropagation();
  };
  const link = (href: string, name: string, description: string) => <a
    key={href}
    className="mdbase-menu-item"
    role="menuitem"
    href={href}
    target="_blank"
    rel="noopener"
    onClick={() => onClose(false)}
  >
    <span className="mdbase-menu-copy">
      <strong>{name}</strong>
      <small>{description}</small>
    </span>
    <ExternalIcon />
    <NewTabHint />
  </a>;
  return <div
    className="mdbase-app-menu-ai"
    onPointerEnter={(event) => { if (event.pointerType === "mouse") show(false); }}
    onPointerLeave={(event) => { if (event.pointerType === "mouse") hideSoon(); }}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hide(false); }}
  >
    <button
      ref={rowRef}
      type="button"
      className="mdbase-menu-item"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? submenuId : undefined}
      onClick={() => show(true)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") {
          event.preventDefault();
          show(true);
        }
      }}
    >
      <McpMark />
      <span className="mdbase-menu-copy">
        <strong>{t({ message: "AI assistants", context: "App switcher" })}</strong>
        <small>{t({ message: "Claude, ChatGPT and others", context: "App switcher" })}</small>
      </span>
      <svg className="mdbase-app-menu-submenu-chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m10 7 5 5-5 5" />
      </svg>
    </button>
    {open && <div
      ref={submenuRef}
      id={submenuId}
      className="mdbase-menu mdbase-overlay mdbase-app-submenu"
      data-open="true"
      popover="manual"
      role="menu"
      aria-label={t({ message: "AI assistants", context: "App switcher" })}
      onKeyDown={onSubmenuKeyDown}
    >
      <div className="mdbase-menu-list">
        {aiAssistants.map((assistant) => link(assistant.url, assistant.name, assistant.description))}
      </div>
      <div className="mdbase-menu-divider" role="separator" />
      <div className="mdbase-menu-list">
        {link(setupUrl, t({ message: "Other AI clients", context: "App switcher" }), t({ message: "Set up with MCP", context: "App switcher" }))}
      </div>
    </div>}
  </div>;
}

function AppItem({ app, current, collectionId, onOpen }: {
  readonly app: OfficialApp;
  readonly current: boolean;
  readonly collectionId?: string | null | undefined;
  readonly onOpen: () => void;
}): JSX.Element {
  useLocaleRevision();
  const copy = <>
    <MdbaseAppMark app={app.id} className="mdbase-app-menu-mark" />
    <span className="mdbase-menu-copy">
      <strong>{app.name}</strong>
      <small>{app.description}</small>
    </span>
  </>;
  if (current) {
    return <div className="mdbase-menu-item is-current" role="menuitem" aria-current="page" aria-disabled="true" tabIndex={-1}>
      {copy}
      <span className="mdbase-app-menu-current">{t({ message: "Current" })}</span>
    </div>;
  }
  return <a
    className="mdbase-menu-item"
    role="menuitem"
    href={mdbaseAppHref(app.url, location.href, collectionId)}
    target="_blank"
    rel="noopener"
    onClick={onOpen}
  >
    {copy}
    <ExternalIcon />
    <NewTabHint />
  </a>;
}
