import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { InfoIcon as Info } from "@phosphor-icons/react/Info";

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
  if (!open) return <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => { setDraft(value); setOpen(true); }}>{label ?? t(i18n)({ message: "Rename", context: "Connect interface" })}</button>;
  return <form className="connect-inline-rename" onSubmit={(event) => void submit(event)}>
    <label><span className="mdbase-visually-hidden">{inputLabel}</span><input className="mdbase-field" autoFocus maxLength={200} value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
    <button className="mdbase-button is-tertiary" type="button" disabled={busy} onClick={() => setOpen(false)}><Trans>Cancel</Trans></button>
    <button className="connect-primary-action mdbase-button is-primary" disabled={busy || !draft.trim() || draft.trim() === value}>{busy ? t(i18n)({ message: "Saving…", context: "Connect interface" }) : t(i18n)({ message: "Save", context: "Connect interface" })}</button>
  </form>;
}
