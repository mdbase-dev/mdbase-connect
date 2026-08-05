import { ArrowLeftIcon as ArrowLeft, TrashIcon as Trash2 } from "./icons";
import type { CollectionDescription } from "@mdbase-dev/connect";
import { useEffect, useState, type ReactNode } from "react";
import type { ConnectionSummary } from "./model";
import type { EditorPreferences } from "./preferences";
import { SelectControl } from "./SelectionControls";
import { applyThemePreference, loadThemePreference, saveThemePreference, type ThemePreference } from "./theme";

export function SettingsView({ description, connection, noteCount, preferences, directAccessBusy, leadingActions, onChange, onBack, onForget, onRequestDirectAccess }: {
  description: CollectionDescription;
  connection: ConnectionSummary | null;
  noteCount: number;
  preferences: EditorPreferences;
  directAccessBusy: boolean;
  leadingActions?: ReactNode;
  onChange: (value: EditorPreferences) => void;
  onBack: () => void;
  onForget: () => void;
  onRequestDirectAccess: () => void;
}) {
  const settings = objectValue(description.configuration?.settings);
  const runtime = objectValue(description.configuration?.runtime);
  const explicitTypeKeys = stringListValue(settings.explicit_type_keys, ["type", "types"]);
  return <main className="settings-view" aria-label="Editor settings">
    <header className="settings-mobile-bar"><button className="mobile-back icon-button" aria-label="Back to collection" onClick={onBack}><ArrowLeft aria-hidden="true" /></button><span>Settings</span></header>
    {leadingActions && <div className="settings-pane-actions">{leadingActions}</div>}
    <div className="settings-document">
      <header><p className="eyebrow">mdbase editor</p><h1>Settings</h1></header>
      <section>
        <div className="settings-intro"><h2>Editing</h2><p>Preferences stay in this browser.</p></div>
        <SettingRow title="Vim key bindings" description="Use normal, insert, visual, and command modes in the note editor.">
          <Toggle checked={preferences.vim} label="Vim key bindings" onChange={(vim) => onChange({ ...preferences, vim })} />
        </SettingRow>
        <SettingRow title="Wrap long lines" description="Keep Markdown visible within the writing measure.">
          <Toggle checked={preferences.lineWrapping} label="Wrap long lines" onChange={(lineWrapping) => onChange({ ...preferences, lineWrapping })} />
        </SettingRow>
        <SettingRow title="Quiet Markdown" description="Soften punctuation away from the active line and make tasks checkable.">
          <Toggle checked={preferences.quietMarkdown} label="Quiet Markdown" onChange={(quietMarkdown) => onChange({ ...preferences, quietMarkdown })} />
        </SettingRow>
        <SettingRow title="Text size" description="Change note text without changing the surrounding interface.">
          <SelectControl aria-label="Editor text size" value={preferences.fontSize} onChange={(event) => onChange({ ...preferences, fontSize: Number(event.target.value) as EditorPreferences["fontSize"] })}>
            <option value="16">Compact</option><option value="17">Comfortable</option><option value="19">Large</option>
          </SelectControl>
        </SettingRow>
        <SettingRow title="Color theme" description="Follow the system appearance or keep a theme in this browser.">
          <ThemeSelect />
        </SettingRow>
      </section>

      <section>
        <div className="settings-intro"><h2>Collection</h2><p>The collection you chose in mdbase connect.</p></div>
        <FactRow label="Name" value={description.displayName} />
        <FactRow label="Specification" value={description.specVersion} />
        <FactRow label="Records" value={String(noteCount)} />
        <FactRow label="Types" value={String(description.types.length)} />
        <FactRow label="Types folder" value={stringValue(settings.types_folder, "_types")} />
        <FactRow label="Explicit type keys" value={explicitTypeKeys.length ? explicitTypeKeys.join(", ") : "Disabled"} mono />
        <FactRow label="Validation" value={stringValue(settings.validation, "error")} />
        <FactRow label="Runtime" value={runtime.enabled === true ? `Enabled · ${stringValue(runtime.profile_version, "0.1.0")}` : "Disabled"} />
      </section>

      <section>
        <div className="settings-intro"><h2>Connection</h2><p>Collection-wide access through mdbase connect. Storage remains local or hosted according to the collection you chose.</p></div>
        <FactRow label="Route" value={connectionRouteLabel(connection)} />
        <DirectAccessRow connection={connection} busy={directAccessBusy} onRequest={onRequestDirectAccess} />
        <FactRow label="Operations" value={description.operations.join(", ")} mono />
        <FactRow label="Collection ID" value={description.collectionId} mono />
        <div className="setting-row connection-action">
          <div><h3>Saved access</h3><p>Remove this collection from the editor without changing its files.</p></div>
          <button className="settings-danger-action" onClick={onForget}><Trash2 aria-hidden="true" />Forget from this browser</button>
        </div>
      </section>
    </div>
  </main>;
}

function ThemeSelect() {
  const [preference, setPreference] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => {
    applyThemePreference(preference);
    if (preference !== "system" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyThemePreference("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);
  return <SelectControl aria-label="Color theme" value={preference} onChange={(event) => {
    const next = event.target.value as ThemePreference;
    setPreference(next);
    saveThemePreference(next);
  }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></SelectControl>;
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><h3>{title}</h3><p>{description}</p></div><div>{children}</div></div>;
}

function FactRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="fact-row"><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>;
}

function DirectAccessRow({ connection, busy, onRequest }: {
  connection: ConnectionSummary | null;
  busy: boolean;
  onRequest: () => void;
}) {
  const status = connection?.directAccess;
  if (status === "available") return <FactRow label="This computer" value="Available" />;
  if (!status || status === "disabled") return null;
  const description = status === "permission_required"
    ? "Allow the editor to reach mdbase on this computer. Editing continues through mdbase whenever it is unavailable."
    : status === "denied"
      ? "Local network access is blocked in this browser. Allow it in the site settings, then check again."
      : status === "checking"
        ? "Checking for mdbase on this computer."
        : "mdbase could not be reached on this computer. You can keep editing through mdbase.";
  const label = status === "permission_required"
    ? "Allow local access"
    : status === "checking" || busy
      ? "Checking…"
      : "Check again";
  return <SettingRow title="This computer" description={description}>
    <button className="settings-secondary-action" disabled={status === "checking" || busy} onClick={onRequest}>{label}</button>
  </SettingRow>;
}

function connectionRouteLabel(connection: ConnectionSummary | null): string {
  if (connection?.authorityKind === "hosted") return "Hosted";
  if (connection?.directAccess === "available") return "This computer";
  return "Via mdbase";
}

function Toggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return <button className={`toggle${checked ? " checked" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span /></button>;
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
