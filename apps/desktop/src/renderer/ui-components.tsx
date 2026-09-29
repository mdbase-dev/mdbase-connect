import { MdbaseMark } from "@mdbase-dev/ui/brand";
import {
  applyThemePreference,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference
} from "@mdbase-dev/ui/theme";
import React, { useEffect, useRef, useState } from "react";
import type { ConnectionDotState } from "./connection-state.mjs";
import { markPairingCompleted } from "./onboarding-state.mjs";
import { defaultConnectServerUrl } from "./runtime-config";
import { message, type Route } from "./view-model";
import { ThemeSelect } from "@mdbase-dev/ui/theme-select";

export function PairingPanel({ resumeAuthorization = false }: { resumeAuthorization?: boolean }) {
  const [serverUrl, setServerUrl] = useState(() => defaultConnectServerUrl(
    import.meta.env.VITE_MDBASE_CONNECT_DEFAULT_SERVER_URL
  ));
  const [connectorName, setConnectorName] = useState("This computer");
  const [pairing, setPairing] = useState<{ pairingId: string; verificationUri: string } | null>(null);
  const [pairError, setPairError] = useState("");
  const [starting, setStarting] = useState(false);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await window.mdbaseConnect.pairingStatus(pairing.pairingId);
        if (result.status === "paired") {
          window.clearInterval(timer);
          markPairingCompleted(localStorage);
          setCompleting(true);
        }
      } catch (error) {
        setPairError(message(error));
        window.clearInterval(timer);
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  async function begin(event: React.FormEvent) {
    event.preventDefault();
    setStarting(true);
    setPairError("");
    try {
      const result = await window.mdbaseConnect.beginPairing({ serverUrl, connectorName });
      setPairing(result);
    } catch (error) {
      setPairError(message(error));
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="pairing-panel">
      <div className="pairing-intro">
        <p className="eyebrow">Account connection</p>
        <h2>{pairing ? "Finish in your browser." : resumeAuthorization ? "Connect this computer to continue." : "Connect this computer to mdbase"}</h2>
        <p>{pairing
          ? "Sign in and approve this computer. This window updates automatically, and there is no code to copy."
          : resumeAuthorization
            ? "Your application request will keep waiting. Sign in so you can choose a folder on this computer, then continue the same request."
            : "Sign in so applications can discover your collections and you can manage their access. Local folders remain on this computer, and their locations stay private."}</p>
      </div>
      {pairError && <div className="message error-message">{pairError}</div>}
      {pairing ? (
        <div className="pairing-wait" role="status" aria-live="polite">
          <StatusDot state="connecting" />
          <div>
            <strong>{completing ? "Computer approved. Connecting securely…" : "Waiting for browser approval"}</strong>
            {completing ? <small>mdbase connect is restarting with the new secure connection.</small> : <code>{pairing.verificationUri}</code>}
          </div>
          {!completing && <button className="quiet-action" onClick={() => setPairing(null)}>Start again</button>}
        </div>
      ) : (
        <form className="pairing-form" onSubmit={(event) => void begin(event)}>
          <label><span>Computer name</span><input value={connectorName} onChange={(event) => setConnectorName(event.target.value)} /></label>
          <details className="pairing-server">
            <summary>Use another Connect server</summary>
            <label><span>Server address</span><input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} /></label>
          </details>
          <button className="button primary" disabled={starting || !serverUrl.trim() || !connectorName.trim()}>{starting ? "Opening browser…" : "Continue in browser"}</button>
        </form>
      )}
    </section>
  );
}

export function ProductSidebar({
  route,
  collectionCount,
  pendingCount,
  connection,
  computerName,
  onSelect
}: {
  route: Route;
  collectionCount: number;
  pendingCount: number;
  connection: { dot: ConnectionDotState; label: string };
  computerName: string;
  onSelect(route: Route): void;
}) {
  return <aside id="product-navigation" className="product-sidebar">
    <div className="product-sidebar-brand"><Brand /></div>
    <nav className="product-sidebar-nav" aria-label="mdbase connect navigation">
      <NavButton route="overview" current={route} label="Overview" onSelect={onSelect} />
      <NavButton route="collections" current={route} label="Collections" count={collectionCount} onSelect={onSelect} />
      <NavButton route="access" current={route} label="App access" attention={pendingCount} onSelect={onSelect} />
      <NavButton route="activity" current={route} label="Activity" onSelect={onSelect} />
    </nav>
    <footer className="product-sidebar-footer">
      <div className="product-sidebar-footer-nav">
        <NavButton route="settings" current={route} label="Settings" onSelect={onSelect} />
      </div>
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

export function MobileProductBar({ open, onOpen }: { open: boolean; onOpen(): void }) {
  return <header className="mobile-product-bar">
    <Brand />
    <button className="mobile-navigation-button" aria-label="Open navigation" aria-controls="product-navigation" aria-expanded={open} onClick={onOpen}><span /></button>
  </header>;
}

export function NavButton({ route, current, label, count, attention, onSelect }: { route: Route; current: Route; label: string; count?: number; attention?: number; onSelect(route: Route): void }) {
  return <button className={`product-sidebar-link ${current === route ? "active" : ""}`} aria-current={current === route ? "page" : undefined} onClick={() => onSelect(route)}><span>{label}</span>{attention ? <b className="product-sidebar-count attention">{attention}</b> : count !== undefined ? <b className="product-sidebar-count">{count}</b> : null}</button>;
}

export function SectionHeading({ title, note, count, children }: { title: string; note: string; count?: number; children?: React.ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div><div className="heading-actions">{count !== undefined && <span className="count">{count}</span>}{children}</div></div>;
}

export function Empty({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?(): void }) {
  return <div className="empty-state"><div className="empty-folder" aria-hidden="true"><span /></div><h3>{title}</h3><p>{text}</p>{action && onAction && <button className="text-action" onClick={onAction}>{action}</button>}</div>;
}

export function StatusDot({ state }: { state: ConnectionDotState }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

export function Brand() {
  return <div className="product-brand"><MdbaseMark className="product-brand-mark" /><strong>mdbase</strong><span className="product-brand-label">connect</span></div>;
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
  return (
    <label className={`${className} ${disabled ? "disabled" : ""}`}>
      <span className="toggle-copy"><strong>{label}</strong><small>{description}</small></span>
      <span className="toggle-action">
        <span className="toggle-state" aria-hidden="true">{stateLabel}</span>
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      </span>
    </label>
  );
}

export function AccessControl({ paused, disabled, onChange }: {
  paused: boolean;
  disabled: boolean;
  onChange(paused: boolean): void;
}) {
  return (
    <div className="access-control">
      <div>
        <strong>{paused ? "App access is paused" : "App access is available"}</strong>
        <small>{paused
          ? "Connected apps remain listed, but this computer is denying their requests."
          : "Approved apps can use the collections you made available."}</small>
      </div>
      <button
        className={`button ${paused ? "primary" : "secondary"}`}
        disabled={disabled}
        onClick={() => onChange(!paused)}
      >
        {paused ? "Resume app access" : "Pause app access"}
      </button>
    </div>
  );
}

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

