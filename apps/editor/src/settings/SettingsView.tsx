import { Trans, useLingui } from "@lingui/react/macro";
import { formatters } from "@mdbase-dev/i18n";
import { LanguageSetting } from "../i18n/LanguageSetting";
import { ShortcutSettings } from "./ShortcutSettings";
import { ArrowLeftIcon as ArrowLeft, CaretRightIcon as ChevronRight, TrashIcon as Trash2 } from "../icons";
import type { CollectionDescription } from "../connect-types";
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { managedAppOrigins } from "../../../../scripts/lib/managed-app-origins.mjs";
import { editorEnvironment } from "../environment";
import type { CollectionGateway, ConnectionSummary } from "../model";
import type { EditorPreferences } from "../preferences";
import { applyThemePreference, loadThemePreference, observeTheme, saveThemePreference, type ThemePreference } from "@mdbase-dev/ui/theme";
import { Select } from "@mdbase-dev/ui/select";
import { ThemeSelect } from "@mdbase-dev/ui/theme-select";

const { tasknotesOrigin, readerOrigin, writerOrigin, journalOrigin } = managedAppOrigins[editorEnvironment];

// Direct Claude and ChatGPT plugin directory URLs can be added alongside
// MCP_SETUP_URL once the published directory listings are live.
const MCP_ENDPOINT_URL = "https://mcp.mdbase.dev/mcp";
const MCP_SETUP_URL = "https://mdbase.dev/apps/mcp/";

function collectionAppUrl(origin: string, collectionId: string): string {
  return `${origin}?collection=${encodeURIComponent(collectionId)}`;
}

// Lazy: the panel and its person setup are only needed in Settings, and stay out of startup.
const YourPersonPanel = lazy(() => import("../YourPersonPanel").then((module) => ({ default: module.YourPersonPanel })));

export function SettingsView({ description, connection, noteCount, preferences, directAccessBusy, leadingActions, gateway, onRefreshDescription, onChange, onBack, onForget, onRequestDirectAccess }: {
  description: CollectionDescription;
  connection: ConnectionSummary | null;
  noteCount: number;
  preferences: EditorPreferences;
  directAccessBusy: boolean;
  leadingActions?: ReactNode;
  gateway?: CollectionGateway;
  onRefreshDescription?: () => Promise<CollectionDescription | undefined>;
  onChange: (value: EditorPreferences) => void;
  onBack: () => void;
  onForget: () => void;
  onRequestDirectAccess: () => void;
}) {
  const { t, i18n } = useLingui();
  const numbers = formatters(i18n.locale);
  const route = connection?.authorityKind === "hosted"
    ? t({ message: "Connected through mdbase", context: "connection route" })
    : connection?.directAccess === "available"
      ? t({ message: "Connected directly", context: "connection route" })
      : t({ message: "Connected through mdbase", context: "connection route" });
  const settings = objectValue(description.configuration?.settings);
  const runtime = objectValue(description.configuration?.runtime);
  const explicitTypeKeys = stringListValue(settings.explicit_type_keys, ["type", "types"]);
  const hasRealCollection = Boolean(
    connection
    && connection.collectionId !== "demo"
    && description.collectionId
    && gateway?.syncState?.() !== "unsynced"
  );
  return <main className="settings-view" aria-label={t({ message: "Editor settings", context: "settings view" })}>
    <header className="settings-mobile-bar"><button className="mobile-back icon-button" aria-label={t({ message: "Back to collection", context: "settings view" })} onClick={onBack}><ArrowLeft aria-hidden="true" /></button><span><Trans context="settings view">Settings</Trans></span></header>
    {leadingActions && <div className="settings-pane-actions">{leadingActions}</div>}
    <div className="settings-document">
      <header><h1><Trans context="settings view">Settings</Trans></h1></header>
      <section>
        <div className="settings-intro"><h2><Trans context="settings view">Editing</Trans></h2><p><Trans context="settings view">Preferences stay in this browser.</Trans></p></div>
        <SettingRow title={t({ message: "Vim key bindings", context: "settings view" })}>
          <Toggle checked={preferences.vim} label={t({ message: "Vim key bindings", context: "settings view" })} onChange={(vim) => onChange({ ...preferences, vim })} />
        </SettingRow>
        <SettingRow title={t({ message: "Wrap long lines", context: "settings view" })}>
          <Toggle checked={preferences.lineWrapping} label={t({ message: "Wrap long lines", context: "settings view" })} onChange={(lineWrapping) => onChange({ ...preferences, lineWrapping })} />
        </SettingRow>
        <SettingRow title={t({ message: "Quiet Markdown", context: "settings view" })} description={t({ message: "Soften punctuation away from the active line and make tasks checkable.", context: "settings view" })}>
          <Toggle checked={preferences.quietMarkdown} label={t({ message: "Quiet Markdown", context: "settings view" })} onChange={(quietMarkdown) => onChange({ ...preferences, quietMarkdown })} />
        </SettingRow>
        <SettingRow title={t({ message: "Typewriter scrolling", context: "settings view" })} description={t({ message: "Keep the caret line centred while writing in focus mode.", context: "settings view" })}>
          <Toggle checked={preferences.typewriterScrolling} label={t({ message: "Typewriter scrolling", context: "settings view" })} onChange={(typewriterScrolling) => onChange({ ...preferences, typewriterScrolling })} />
        </SettingRow>
        <SettingRow title={t({ message: "Text size", context: "settings view" })}>
          <Select aria-label={t({ message: "Editor text size", context: "settings view" })} value={String(preferences.fontSize)} options={[{ value: "16", label: t({ message: "Compact", context: "editor text size" }) }, { value: "17", label: t({ message: "Comfortable", context: "editor text size" }) }, { value: "19", label: t({ message: "Large", context: "editor text size" }) }]} onChange={(next) => onChange({ ...preferences, fontSize: Number(next) as EditorPreferences["fontSize"] })} />
        </SettingRow>
        <SettingRow title={t({ message: "Color theme", context: "settings view" })}>
          <ThemePreferenceSetting />
        </SettingRow>
        <LanguageSetting />
      </section>

      <ShortcutSettings />

      <section>
        <div className="settings-intro"><h2><Trans context="settings view">Collection</Trans></h2></div>
        <FactRow label={t({ message: "Name", context: "settings view" })} value={description.displayName} />
        <FactRow label={t({ message: "Notes", context: "settings view" })} value={numbers.number(noteCount)} />
        <FactRow label={t({ message: "Types", context: "settings view" })} value={numbers.number(description.types.length)} />
        <details className="settings-details">
          <summary><span><Trans context="settings view">Details</Trans></span><ChevronRight aria-hidden="true" /></summary>
          <FactRow label={t({ message: "Specification", context: "settings view" })} value={description.specVersion} />
          <FactRow label={t({ message: "Types folder", context: "settings view" })} value={stringValue(settings.types_folder, "_types")} mono />
          <FactRow label={t({ message: "Explicit type keys", context: "settings view" })} value={explicitTypeKeys.length ? explicitTypeKeys.join(", ") : t({ message: "Disabled", context: "explicit type keys setting" })} />
          <FactRow label={t({ message: "Validation", context: "settings view" })} value={stringValue(settings.validation, "error")} />
          <FactRow label={t({ message: "Runtime", context: "settings view" })} value={runtime.enabled === true ? t`Enabled · ${stringValue(runtime.profile_version, "0.1.0")}` : t({ message: "Disabled", context: "collection runtime" })} />
        </details>
      </section>

      {hasRealCollection && <OtherAppsSection collectionId={description.collectionId} />}

      {gateway?.peopleDirectory && <Suspense fallback={null}><YourPersonPanel key={description.collectionId} gateway={gateway} description={description} canInstall={connection?.operations.includes("apply_type_pack") ?? false} onRefreshDescription={onRefreshDescription} canCreate={connection?.operations.includes("create") ?? false} canEdit={connection?.operations.includes("update") ?? false} /></Suspense>}

      <section>
        <div className="settings-intro"><h2><Trans context="settings view">Connection</Trans></h2></div>
        {connection?.authorityKind === "hosted" && <FactRow label={t({ message: "Main copy", context: "settings view" })} value={t({ message: "Hosted by mdbase", context: "settings view" })} />}
        <FactRow label={t({ message: "Route", context: "settings view" })} value={route} />
        <DirectAccessRow connection={connection} busy={directAccessBusy} onRequest={onRequestDirectAccess} />
        <div className="setting-row connection-action">
          <div><h3><Trans context="settings view">Saved access</Trans></h3><p><Trans context="settings view">Remove this collection from the editor without changing its files.</Trans></p></div>
          <button className="settings-danger-action mdbase-button is-tertiary is-danger" onClick={onForget}><Trash2 aria-hidden="true" /><Trans context="settings view">Forget from this browser</Trans></button>
        </div>
        <details className="settings-details">
          <summary><span><Trans context="settings view">Details</Trans></span><ChevronRight aria-hidden="true" /></summary>
          <FactRow label={t({ message: "Operations", context: "settings view" })} value={description.operations.join(", ")} />
          <FactRow label={t({ message: "Collection ID", context: "settings view" })} value={description.collectionId} />
        </details>
      </section>
    </div>
  </main>;
}

function OtherAppsSection({ collectionId }: { collectionId: string }) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
  }, []);

  async function copyEndpoint() {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(MCP_ENDPOINT_URL);
    } catch {
      return;
    }
    setCopied(true);
    if (copyTimer.current !== undefined) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      setCopied(false);
      copyTimer.current = undefined;
    }, 2000);
  }

  const apps = [
    {
      name: "TaskNotes",
      description: t({ message: "Plan tasks, boards and calendars", context: "settings view" }),
      href: collectionAppUrl(tasknotesOrigin, collectionId)
    },
    {
      name: "Reader",
      description: t({ message: "Read and annotate PDFs, EPUBs and web pages", context: "settings view" }),
      href: collectionAppUrl(readerOrigin, collectionId)
    },
    {
      name: "Writer",
      description: t({ message: "Write papers and books citing your sources", context: "settings view" }),
      href: collectionAppUrl(writerOrigin, collectionId)
    },
    {
      name: "Journal",
      description: t({ message: "Keep a daily Markdown journal", context: "settings view" }),
      href: collectionAppUrl(journalOrigin, collectionId)
    }
  ];

  return <section>
    <div className="settings-intro">
      <h2><Trans context="settings view">Other apps</Trans></h2>
      <p><Trans context="settings view">Open this collection in another mdbase app or connect an AI client.</Trans></p>
    </div>
    {apps.map((app) => (
      <SettingRow key={app.name} title={app.name} description={app.description}>
        <a
          className="settings-secondary-action mdbase-button"
          href={app.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t({ message: `Open ${app.name}`, context: "settings view" })}
        >
          <Trans context="settings view">Open</Trans>
        </a>
      </SettingRow>
    ))}
    <div className="setting-row settings-mcp-row">
      <div>
        <h3><Trans context="settings view">Claude, ChatGPT &amp; Codex (MCP &amp; plugins)</Trans></h3>
        <p><code className="settings-endpoint">{MCP_ENDPOINT_URL}</code></p>
      </div>
      <div className="setting-controls">
        <button
          type="button"
          className="settings-secondary-action mdbase-button"
          onClick={() => void copyEndpoint()}
        >
          {copied ? t({ message: "Copied", context: "settings view" }) : t({ message: "Copy", context: "settings view" })}
        </button>
        <a
          className="settings-secondary-action mdbase-button"
          href={MCP_SETUP_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Trans context="settings view">Set up</Trans>
        </a>
      </div>
    </div>
  </section>;
}

function ThemePreferenceSetting() {
  const { t } = useLingui();
  const [preference, setPreference] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => observeTheme(() => setPreference(loadThemePreference())), []);
  useEffect(() => {
    applyThemePreference(preference);
    if (preference !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyThemePreference("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);
  return <ThemeSelect label={t({ message: "Color theme", context: "settings view" })} value={preference} onChange={(next) => {
    setPreference(next);
    saveThemePreference(next);
  }} />;
}

/** A description is for a setting whose name does not already say what it does. */
function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><h3>{title}</h3>{description && <p>{description}</p>}</div><div>{children}</div></div>;
}

function FactRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="fact-row"><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>;
}

function DirectAccessRow({ connection, busy, onRequest }: {
  connection: ConnectionSummary | null;
  busy: boolean;
  onRequest: () => void;
}) {
  const { t } = useLingui();
  const status = connection?.directAccess;
  if (status === "available") return <FactRow label={t({ message: "This computer", context: "settings view" })} value={t({ message: "Available", context: "direct connection availability" })} />;
  if (!status || status === "disabled") return null;
  const description = status === "permission_required"
    ? t({ message: "Allow the editor to reach mdbase on this computer. Editing continues through mdbase whenever it is unavailable.", context: "settings view" })
    : status === "denied"
      ? t({ message: "Local network access is blocked in this browser. Allow it in the site settings, then check again.", context: "settings view" })
      : status === "checking"
        ? t({ message: "Checking for mdbase on this computer.", context: "settings view" })
        : t({ message: "mdbase could not be reached on this computer. You can keep editing through mdbase.", context: "settings view" });
  const label = status === "permission_required"
    ? t({ message: "Allow local access", context: "settings view" })
    : status === "checking" || busy
      ? t({ message: "Checking…", context: "settings view" })
      : t({ message: "Check again", context: "settings view" });
  return <SettingRow title={t({ message: "This computer", context: "settings view" })} description={description}>
    <button className="settings-secondary-action mdbase-button" disabled={status === "checking" || busy} onClick={onRequest}>{label}</button>
  </SettingRow>;
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <button className="mdbase-switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span aria-hidden="true" /></button>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && !Array.isArray(value) && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringListValue(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}
