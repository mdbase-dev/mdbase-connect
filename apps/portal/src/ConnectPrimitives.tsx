import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InfoIcon as Info } from "@phosphor-icons/react/Info";
import { ManagementApiError } from "@mdbase/connect-management";
import { collectionQuotaMessage } from "./collection-quota-copy.generated";

export function ConnectPreview({ title, rows, pending, error, retry }: {
  title: string;
  rows?: ReadonlyArray<{ id: string; name: string }>;
  error: string;
  pending: boolean;
  retry(): void;
}) {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!pending) { setDelayed(false); return; }
    const timer = window.setTimeout(() => setDelayed(true), 150);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return <ConnectPage title={title}><section aria-busy={pending}>
    {error ? <div className="connect-load-error" role="alert"><Info aria-hidden="true" /><div><strong><Trans>We couldn't load {title}</Trans></strong><p>{error}</p><button className="mdbase-button is-secondary" aria-disabled={pending} onClick={() => { if (!pending) retry(); }}><Trans>Try again</Trans></button></div></div> : <>
    {delayed && <p className="connect-muted" role="status"><Trans>Loading {title}…</Trans></p>}
    {rows?.map(row => <div className="connect-row" key={row.id}><div><strong>{row.name}</strong><small><Trans>Last known details</Trans></small></div></div>)}
    {pending && delayed && !rows && <div className="connect-skeleton" aria-hidden="true">{[0, 1, 2].map(row => <div key={row}><i /><span><b /><small /></span><b /></div>)}</div>}
    </>}
  </section></ConnectPage>;
}

export function ConnectPage({ title, intro, status, action, reading = false, children }: {
  title: string;
  intro?: string;
  status?: ReactNode;
  action?: ReactNode;
  reading?: boolean;
  children: ReactNode;
}) {
  useLocaleRevision();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const page = heading.current!.closest(".connect-page")!;
    let focused: HTMLElement | null = null;
    let targets: HTMLElement[] = [];
    const track = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest("dialog")) return;
      focused = target.closest("[data-list-item]");
      const rows = [...page.querySelectorAll<HTMLElement>("[data-list-item]")];
      const index = focused ? rows.indexOf(focused) : -1;
      targets = index < 0 ? [] : [...rows.slice(index + 1), ...rows.slice(0, index).reverse()];
    };
    const observer = new MutationObserver(() => {
      if (!focused || focused.isConnected || document.querySelector("dialog[open]")) return;
      if (document.activeElement === document.body) {
        const row = targets.find(target => target.isConnected);
        const target = row?.querySelector<HTMLElement>("a, button, summary") ?? heading.current;
        target?.focus({ preventScroll: true });
      }
      focused = null;
    });
    document.addEventListener("focusin", track);
    observer.observe(page, { childList: true, subtree: true });
    return () => { observer.disconnect(); document.removeEventListener("focusin", track); };
  }, [title]);
  useLayoutEffect(() => {
    document.title = `${title} - mdbase Connect`;
    const main = heading.current?.closest(".connect-main");
    if (main instanceof HTMLElement) main.scrollTo?.({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [title]);
  return <div className={reading ? "connect-page is-reading" : "connect-page"}>
    <header><div><h1 ref={heading} tabIndex={-1}>{title}</h1>{intro && <span>{intro}</span>}{status}</div>{action}</header>
    {children}
  </div>;
}

export function ConnectSectionTitle({ title, note, count, action }: {
  title: string;
  note?: string;
  count?: number;
  action?: ReactNode;
}) {
  useLocaleRevision();
  return <header className="connect-section-title">
    <div><h2>{title}</h2>{count !== undefined && <span>{i18n.number(count)}</span>}</div>
    {note && <p>{note}</p>}
    {action}
  </header>;
}

export function ConnectEmpty({ title, body, action, icon = true }: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: boolean;
}) {
  useLocaleRevision();
  return <div className="connect-empty">
    {icon && <Info aria-hidden="true" />}
    <div><strong>{title}</strong><p>{body}</p>{action}</div>
  </div>;
}

export function ListFilter({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  useLocaleRevision();
  const input = useRef<HTMLInputElement>(null);
  return <div className="connect-list-filter"><label><span className="mdbase-visually-hidden">{label}</span><input ref={input} className="mdbase-field" type="search" aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)} /><kbd aria-hidden="true">/</kbd></label><button type="button" className="mdbase-icon-button" hidden={!value} aria-label={t(i18n)`Clear search`} onClick={() => { onChange(""); input.current!.focus(); }}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>;
}

export function DesktopLink({ href, role, children }: { href: string; role?: "menuitem"; children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const opened = () => { window.clearTimeout(timer.current); setFailed(false); };
    window.addEventListener("blur", opened);
    return () => { window.clearTimeout(timer.current); window.removeEventListener("blur", opened); };
  }, []);
  return <><a className={role ? "mdbase-menu-item" : "mdbase-button is-tertiary"} role={role} href={href} onClick={() => {
    setFailed(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFailed(true), 1500);
  }}>{children}</a>{failed && <p className="connect-desktop-help" role="status"><Trans>If the desktop app did not open, <a href="https://mdbase.dev/downloads/" target="_blank" rel="noreferrer">install the latest release</a> and try again.</Trans></p>}</>;
}

export function relativeTime(value: string): string {
  const seconds = Math.min(0, Math.round((new Date(value).getTime() - Date.now()) / 1_000));
  if (seconds > -60) return t(i18n)`Just now`;
  const format = new Intl.RelativeTimeFormat(i18n.locale, { numeric: "auto" });
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error && "status" in value && typeof value.status === "number" && value.status >= 500) return t(i18n)`Something went wrong on mdbase. Try again.`;
  if (value instanceof ManagementApiError && value.details && typeof value.details === "object" && "code" in value.details && value.details.code === "account_collection_quota_exceeded") return collectionQuotaMessage();
  const detail = value instanceof Error ? value.message : String(value);
  return /failed to fetch|networkerror|network request failed/i.test(detail)
    ? t(i18n)({ message: "mdbase Connect could not be reached. Check your connection and try again." })
    : detail;
}
