import { useId, useRef, useState, type JSX, type RefObject } from "react";

import { mdbaseAppHref, withAppUrls, type MdbaseApp, type MdbaseAppId } from "./apps.js";
import { MdbaseAppMark, Wordmark, type MdbaseMarkMotion } from "./brand.js";
import { useMdbaseMarkActivity } from "./mark-activity.js";
import { moveMenuFocus, useMenuPopover } from "./popover.js";

/** The switcher plays its entrance once per page, not every time it remounts. */
let entrancePlayed = false;

/**
 * The product wordmark as a menu for opening the current collection in the other mdbase apps.
 * Each opens in a new tab so the current app stays where it is.
 *
 * Its mark shows the page's activity (see `mark-activity`): progress, then a held loop,
 * then `motion`. Without a `motion` it plays `keys-first` the first time it appears.
 */
export function AppSwitcher({ current, urls = {}, motion }: {
  readonly current: MdbaseAppId;
  /** Lab and local builds, for example `{ writer: import.meta.env.VITE_MDBASE_WRITER_URL }`. */
  readonly urls?: Partial<Record<MdbaseAppId, string | undefined>>;
  readonly motion?: MdbaseMarkMotion | undefined;
}): JSX.Element {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [entrance] = useState<MdbaseMarkMotion | undefined>(() => {
    if (motion || entrancePlayed || typeof window === "undefined") return undefined;
    entrancePlayed = true;
    return "keys-first";
  });
  const activity = useMdbaseMarkActivity();
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  return <>
    <button
      ref={triggerRef}
      type="button"
      className="mdbase-app-switcher"
      aria-label={`mdbase ${current}: open this collection in another app`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      title="Open in another mdbase app"
      onClick={() => (open ? close(false) : setOpen(true))}
      onKeyDown={(event) => {
        if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    >
      <Wordmark app={current} motion={activity.busy ?? motion ?? entrance} signal={activity.signal} progress={activity.progress} />
      <svg className="mdbase-app-switcher-chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m7 10 5 5 5-5" />
      </svg>
    </button>
    {open ? <AppMenu id={menuId} apps={withAppUrls(urls)} current={current} triggerRef={triggerRef} onClose={close} /> : null}
  </>;
}

function AppMenu({ id, apps, current, triggerRef, onClose }: {
  readonly id: string;
  readonly apps: readonly MdbaseApp[];
  readonly current: MdbaseAppId;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onClose: (refocus: boolean) => void;
}): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuPopover(menuRef, triggerRef, onClose, { width: 320, focus: 'a[role="menuitem"]' });
  const heading = new URL(location.href).searchParams.has("collection") ? "Open this collection in" : "mdbase apps";
  return <div
    ref={menuRef}
    id={id}
    className="mdbase-menu"
    popover="manual"
    role="menu"
    aria-label={heading}
    tabIndex={-1}
    onKeyDown={(event) => moveMenuFocus(event, menuRef.current)}
  >
    <div className="mdbase-menu-heading" role="presentation">{heading}</div>
    <div className="mdbase-menu-list">
      {apps.map((app) => <AppItem key={app.id} app={app} current={app.id === current} onOpen={() => onClose(false)} />)}
    </div>
    <p className="mdbase-menu-note">Opens in a new tab</p>
  </div>;
}

function AppItem({ app, current, onOpen }: {
  readonly app: MdbaseApp;
  readonly current: boolean;
  readonly onOpen: () => void;
}): JSX.Element {
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
      <span className="mdbase-app-menu-current">Current</span>
    </div>;
  }
  return <a
    className="mdbase-menu-item"
    role="menuitem"
    href={mdbaseAppHref(app.url, location.href)}
    target="_blank"
    rel="noopener"
    onClick={onOpen}
  >
    {copy}
    <svg className="mdbase-app-menu-external" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 5.5H5.5v13h13V14M13.5 5.5h5v5M18.5 5.5 11 13" />
    </svg>
    <span className="mdbase-visually-hidden"> (opens in a new tab)</span>
  </a>;
}
