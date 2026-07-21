import { ArrowLeft } from "lucide-react";
import type { CollectionDescription } from "@mdbase/connect";
import type { ReactNode } from "react";
import type { EditorPreferences } from "./preferences";

export function SettingsView({ description, noteCount, preferences, leadingActions, onChange, onBack }: {
  description: CollectionDescription;
  noteCount: number;
  preferences: EditorPreferences;
  leadingActions?: ReactNode;
  onChange: (value: EditorPreferences) => void;
  onBack: () => void;
}) {
  const settings = objectValue(description.configuration?.settings);
  const runtime = objectValue(description.configuration?.runtime);
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
        <SettingRow title="Text size" description="Change note text without changing the surrounding interface.">
          <select aria-label="Editor text size" value={preferences.fontSize} onChange={(event) => onChange({ ...preferences, fontSize: Number(event.target.value) as EditorPreferences["fontSize"] })}>
            <option value="16">Compact</option><option value="17">Comfortable</option><option value="19">Large</option>
          </select>
        </SettingRow>
      </section>

      <section>
        <div className="settings-intro"><h2>Collection</h2><p>The collection you chose in mdbase connect.</p></div>
        <FactRow label="Name" value={description.display_name} />
        <FactRow label="Specification" value={description.spec_version} />
        <FactRow label="Records" value={String(noteCount)} />
        <FactRow label="Types" value={String(description.types.length)} />
        <FactRow label="Types folder" value={stringValue(settings.types_folder, "_types")} />
        <FactRow label="Validation" value={stringValue(settings.validation, "error")} />
        <FactRow label="Runtime" value={runtime.enabled === true ? `Enabled · ${stringValue(runtime.profile_version, "0.1.0")}` : "Disabled"} />
      </section>

      <section>
        <div className="settings-intro"><h2>Connection</h2><p>Collection-wide access through mdbase connect. Storage remains local or hosted according to the collection you chose.</p></div>
        <FactRow label="Operations" value={description.operations.join(", ")} mono />
        <FactRow label="Collection ID" value={description.collection_id} mono />
      </section>
    </div>
  </main>;
}

function SettingRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><h3>{title}</h3><p>{description}</p></div><div>{children}</div></div>;
}

function FactRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="fact-row"><span>{label}</span><strong className={mono ? "mono" : ""}>{value}</strong></div>;
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
