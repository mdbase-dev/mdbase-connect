import { MdbaseMark, type MdbaseMarkMotion, type MdbaseMarkSignal } from "@mdbase-dev/ui/brand";
import {
  applyThemePreference,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference
} from "@mdbase-dev/ui/theme";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { ThemeSelect } from "@mdbase-dev/ui/theme-select";

export interface ProductSidebarItem {
  id: string;
  label: string;
  href?: string;
  count?: number;
  attention?: boolean;
}

export function ProductSidebar({ items, active, account, identity, editorHref, accountHref = "/account", onNavigate }: {
  items: ProductSidebarItem[];
  active: string;
  account: string;
  identity: string;
  editorHref: string;
  accountHref?: string;
  onNavigate(id: string, href: string): void;
}) {
  const follow = (event: MouseEvent<HTMLAnchorElement>, id: string, href: string) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(id, href);
  };
  return <aside id="product-navigation" className="product-sidebar">
    <div className="product-sidebar-brand"><Brand productLabel /></div>
    <nav className="product-sidebar-nav" aria-label="mdbase connect navigation">
      {items.map((item) => <a
        key={item.id}
        className={`product-sidebar-link ${active === item.id ? "active" : ""}`}
        href={item.href ?? `/${item.id}`}
        aria-current={active === item.id ? "page" : undefined}
        onClick={(event) => follow(event, item.id, item.href ?? `/${item.id}`)}
      >
        <span>{item.label}</span>
        {item.count !== undefined && <b className={`product-sidebar-count ${item.attention ? "attention" : ""}`}>{item.count}</b>}
      </a>)}
    </nav>
    <footer className="product-sidebar-footer">
      <div className="product-sidebar-footer-nav">
        <a
          className={`product-sidebar-link ${active === "account" ? "active" : ""}`}
          href={accountHref}
          aria-current={active === "account" ? "page" : undefined}
          onClick={(event) => follow(event, "account", accountHref)}
        >Account</a>
      </div>
      <div className="product-sidebar-account">
        <span className="product-sidebar-account-copy"><strong>{account}</strong><small>{identity}</small></span>
        <ThemeMenu />
      </div>
      <div className="product-sidebar-utilities">
        <a className="product-sidebar-utility" href={editorHref} target="_blank" rel="noreferrer">Open editor <span aria-hidden="true">↗</span></a>
      </div>
    </footer>
  </aside>;
}

export function MobileProductBar({ open, onOpen }: { open: boolean; onOpen(): void }) {
  return <header className="mobile-product-bar">
    <Brand productLabel />
    <button className="mobile-navigation-button" aria-label="Open navigation" aria-controls="product-navigation" aria-expanded={open} onClick={onOpen}><span /></button>
  </header>;
}

export function AccountRow({ label, value, detail, mono = false }: { label: string; value: string; detail?: string; mono?: boolean }) { return <div className="account-row"><span>{label}</span><div><strong className={mono ? "mono" : ""}>{value}</strong>{detail && <small>{detail}</small>}</div></div>; }
export function ThemeMenu() {
  const [preference, setPreference] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => {
    applyThemePreference(preference);
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyThemePreference("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);
  return <ThemeSelect className="theme-select" value={preference} onChange={(next) => {
    setPreference(next);
    saveThemePreference(next);
  }} />;
}

/** The page's mark loops while `busy` and shakes each time a new `error` appears. */
export function PageBrand({ label, markMotion, busy = false, error = "" }: { label: string; markMotion?: MdbaseMarkMotion; busy?: boolean; error?: string }) {
  const signal = useErrorSignal(error);
  return <div className="page-brand-row"><div className="page-brand"><Brand markMotion={busy ? "bounce" : markMotion} markSignal={signal} /><span>{label}</span></div><ThemeMenu /></div>;
}
export function Brand({ productLabel = false, markMotion, markSignal }: { productLabel?: boolean; markMotion?: MdbaseMarkMotion; markSignal?: MdbaseMarkSignal | null }) { return <div className="product-brand"><MdbaseMark motion={markMotion} signal={markSignal} className="product-brand-mark" /><strong>mdbase</strong>{productLabel && <span className="product-brand-label">connect</span>}</div>; }
function useErrorSignal(error: string): MdbaseMarkSignal | null {
  const [signal, setSignal] = useState<MdbaseMarkSignal | null>(null);
  useEffect(() => setSignal((current) => error ? { kind: "error", id: (current?.id ?? 0) + 1 } : null), [error]);
  return signal;
}

export function SectionHeading({ title, note, count }: { title: string; note: string; count?: number }) { return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div>{count !== undefined && <span>{count}</span>}</div>; }
export function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span className="empty-folder" /><strong>{title}</strong><p>{text}</p></div>; }
export function Loading({ error = "", onRetry }: { error?: string; onRetry?(): void }) { return <main className="loading" aria-busy={!error}><PageBrand label="connect" markMotion="orbit" error={error} /><p role={error ? "alert" : "status"}>{error || "Opening mdbase connect…"}</p>{error && onRetry && <button className="button primary" onClick={onRetry}>Try again</button>}</main>; }

