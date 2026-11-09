import { t } from "@lingui/core/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { shortcutLabel } from "@mdbase-dev/ui/command-palette";
import { useMdbaseMarkActivity } from "@mdbase-dev/ui/mark-activity";
import { useNavPill } from "@mdbase/connect-ui/nav-pill";
import { StatusGlyph, type StatusGlyphState } from "@mdbase/connect-ui/status-glyph";
import {
  applyThemePreference,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference
} from "@mdbase-dev/ui/theme";
import React, { useEffect, useRef, useState } from "react";
import type { ConnectionDotState } from "./daemon-view.mjs";
import { message, type Route } from "./view-model";
import { ThemeSelect } from "@mdbase-dev/ui/theme-select";

export function ListFilter({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  useLocaleRevision();
  const input = useRef<HTMLInputElement>(null);
  return <div className="collection-filter"><input ref={input} className="mdbase-field" type="search" aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)} />{value && <button className="mdbase-button is-tertiary" onClick={() => { onChange(""); input.current!.focus(); }}>{t(i18n)`Clear filter`}</button>}</div>;
}

export function ProductSidebar({
  route,
  collectionCount,
  pendingCount,
  deviceCount,
  signingIn,
  connection,
  computerName,
  onSelect,
  onSearch
}: {
  route: Route;
  collectionCount: number;
  pendingCount: number;
  /** New devices waiting to open a Private collection. */
  deviceCount?: number;
  signingIn: boolean;
  connection: { dot: ConnectionDotState; label: string };
  computerName: string;
  onSelect(route: Route): void;
  onSearch(): void;
}) {
  useLocaleRevision();
  const nav = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  useNavPill(nav, pill);
  return <aside id="product-navigation" className="product-sidebar">
    <div className="product-sidebar-brand"><Brand signingIn={signingIn} /></div>
    <button className="sidebar-search" onClick={onSearch}><span>{t(i18n)({ message: "Search", context: "Connect interface" })}</span><kbd>{shortcutLabel("mod+k")}</kbd></button>
    <nav ref={nav} className="product-sidebar-nav" aria-label={t(i18n)({ message: "mdbase connect navigation" })}>
      <span ref={pill} className="nav-pill" aria-hidden="true" hidden />
      <NavButton route="overview" current={route} label={t(i18n)({ message: "Home", context: "Connect interface" })} onSelect={onSelect} />
      <NavButton route="collections" current={route} label={t(i18n)({ message: "Collections", context: "Connect interface" })} count={collectionCount} attention={deviceCount} onSelect={onSelect} />
      <NavButton route="access" current={route} label={t(i18n)({ message: "Apps", context: "Connect interface" })} attention={pendingCount} onSelect={onSelect} />
      <NavButton route="activity" current={route} label={t(i18n)({ message: "Activity", context: "Connect interface" })} onSelect={onSelect} />
      <NavButton route="settings" current={route} label={t(i18n)({ message: "Settings", context: "Connect interface" })} onSelect={onSelect} />
    </nav>
    <footer className="product-sidebar-footer">
      <div className="product-sidebar-status" role="status" aria-live="polite">
        <StatusDot state={connection.dot} />
        <span className="product-sidebar-status-copy">
          <strong>{connection.label}</strong>
          <small>{computerName}</small>
        </span>
      </div>
    </footer>
  </aside>;
}

export function MobileProductBar({ open, signingIn, onOpen }: { open: boolean; signingIn: boolean; onOpen(): void }) {
  useLocaleRevision();
  return <header className="mobile-product-bar">
    <Brand signingIn={signingIn} />
    <button className="mobile-navigation-button" aria-label={t(i18n)({ message: "Open navigation", context: "Connect interface" })} aria-controls="product-navigation" aria-expanded={open} onClick={onOpen}><span /></button>
  </header>;
}

export function NavButton({ route, current, label, count, attention, onSelect }: { route: Route; current: Route; label: string; count?: number; attention?: number; onSelect(route: Route): void }) {
  useLocaleRevision();
  return <button className={`product-sidebar-link ${current === route ? "active" : ""}`} aria-current={current === route ? "page" : undefined} onClick={() => onSelect(route)}><span>{label}</span>{attention ? <b className="product-sidebar-count attention">{i18n.number(attention)}</b> : count !== undefined ? <b className="product-sidebar-count">{i18n.number(count)}</b> : null}</button>;
}

export function SectionHeading({ title, note, count, children }: { title: string; note: string; count?: number; children?: React.ReactNode }) {
  useLocaleRevision();
  return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div><div className="heading-actions">{count !== undefined && <span className="count">{i18n.number(count)}</span>}{children}</div></div>;
}

export function Empty({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?(): void }) {
  useLocaleRevision();
  return <div className="empty-state"><div className="empty-folder" aria-hidden="true"><span /></div><h3>{title}</h3><p>{text}</p>{action && onAction && <button className="mdbase-button is-tertiary" onClick={onAction}>{action}</button>}</div>;
}

const glyphForDot: Record<ConnectionDotState, StatusGlyphState> = {
  connected: "online",
  connecting: "connecting",
  paused: "paused",
  danger: "attention",
  idle: "idle"
};

export function StatusDot({ state }: { state: ConnectionDotState }) {
  return <StatusGlyph state={glyphForDot[state]} />;
}

export function Brand({ signingIn }: { signingIn: boolean }) {
  useLocaleRevision();
  const { signal, busy } = useMdbaseMarkActivity();
  return <div className="product-brand"><MdbaseMark className="product-brand-mark" motion={busy ?? (signingIn ? "keys-first" : undefined)} signal={signal} /><strong>mdbase</strong><span className="product-brand-label">connect</span></div>;
}

export function SettingSwitch({ className, label, description, checked, disabled, stateLabel, onChange }: {
  className: "pause-control" | "setting-toggle";
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  stateLabel: string;
  onChange(checked: boolean): void;
}) {
  useLocaleRevision();
  return (
    <label className={`${className} ${disabled ? "disabled" : ""}`}>
      <span className="toggle-copy"><strong>{label}</strong><small>{description}</small></span>
      <span className="toggle-action">
        <span className="toggle-state" aria-hidden="true">{stateLabel}</span>
        <button
          type="button"
          className="mdbase-switch"
          role="switch"
          aria-label={label}
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
        ><span aria-hidden="true" /></button>
      </span>
    </label>
  );
}

export function ThemeMenu() {
  useLocaleRevision();
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

