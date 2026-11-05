import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { InfoIcon as Info } from "@phosphor-icons/react/Info";
import { Dialog } from "@mdbase-dev/ui/dialog";

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
    {error && !pending ? <div className="connect-load-error" role="alert"><Info aria-hidden="true" /><div><strong><Trans>We couldn't load {title}</Trans></strong><p><Trans>Check your connection and try again.</Trans></p><button className="mdbase-button is-secondary" onClick={retry}><Trans>Try again</Trans></button></div></div> : <>
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
    document.title = `${title} - mdbase connect`;
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

export function InlineRename({ value, label, inputLabel, busy = false, onSubmit }: {
  value: string;
  label?: string;
  inputLabel: string;
  busy?: boolean;
  onSubmit(value: string): Promise<boolean>;
}) {
  useLocaleRevision();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (!next || next === value) return;
    if (await onSubmit(next)) setOpen(false);
  }
  return <><button className="mdbase-button is-tertiary" disabled={busy} onClick={() => { setDraft(value); setOpen(true); }}>{label ?? t(i18n)({ message: "Rename", context: "Connect interface" })}</button>
  <Dialog open={open} title={inputLabel} closeDisabled={busy} onClose={() => setOpen(false)}><form className="connect-edit-form" onSubmit={(event) => void submit(event)}>
    <label><span className="mdbase-visually-hidden">{inputLabel}</span><input className="mdbase-field" autoFocus maxLength={200} value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
    <button className="mdbase-button is-tertiary" type="button" disabled={busy} onClick={() => setOpen(false)}><Trans>Cancel</Trans></button>
    <button className="connect-primary-action mdbase-button is-primary" disabled={busy || !draft.trim() || draft.trim() === value}>{busy ? t(i18n)({ message: "Saving…", context: "Connect interface" }) : t(i18n)({ message: "Save", context: "Connect interface" })}</button>
  </form></Dialog></>;
}

export function ListFilter({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return <label className="connect-list-filter"><span className="mdbase-visually-hidden">{label}</span><input className="mdbase-field" type="search" aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)} /></label>;
}

export function DesktopLink({ href, role, children }: { href: string; role?: "menuitem"; children: ReactNode }) {
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const opened = () => { window.clearTimeout(timer.current); setFailed(false); };
    window.addEventListener("blur", opened);
    return () => { window.clearTimeout(timer.current); window.removeEventListener("blur", opened); };
  }, []);
  return <><a className={role ? undefined : "mdbase-button is-tertiary"} role={role} href={href} onClick={() => {
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
  const detail = value instanceof Error ? value.message : String(value);
  return /failed to fetch|networkerror|network request failed/i.test(detail)
    ? t(i18n)({ message: "mdbase connect could not be reached. Check your connection and try again." })
    : detail;
}
