import { useLingui } from "@lingui/react/macro";
import { shortcutLabel } from "@mdbase-dev/ui/command-palette";
import { useState, type KeyboardEvent } from "react";
import { chordFromEvent, commandDefinitions, commandShortcuts, isShortcutChanged, releaseChord, resetShortcuts, setCommandShortcuts, shortcutOwner, useShortcuts, type CommandDefinition, type CommandId } from "../editor-commands";
import { ArrowCounterClockwiseIcon as Reset, XIcon as Remove } from "../icons";

const editable = (Object.keys(commandDefinitions) as CommandId[]).filter((id) => !(commandDefinitions[id] as CommandDefinition).fixed);

/** A chord another command already has, waiting for the person to replace it there or keep it. */
interface Conflict { id: CommandId; chord: string; owner: CommandId }

/** Per-device key bindings for every command the palette offers. */
export function ShortcutSettings() {
  const { t } = useLingui();
  const overrides = useShortcuts();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<CommandId>();
  const [conflict, setConflict] = useState<Conflict>();
  const label = (id: CommandId) => (commandDefinitions[id] as CommandDefinition).label;
  // The shortcut help's groups, so a command sits under the same heading in both.
  const groups = [["Navigate", t`Navigate`], ["Note", t`Note`], ["Text", t`Text`], ["Other", t({ message: "Other", context: "shortcut group" })]] as const;
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = editable.filter((id) => {
    const { label, hint } = commandDefinitions[id] as CommandDefinition;
    const text = [label, hint, ...commandShortcuts(id).map(shortcutLabel)].join(" ").toLocaleLowerCase();
    return tokens.every((token) => text.includes(token));
  });

  const focusChange = (id: CommandId) => requestAnimationFrame(() => document.getElementById(`shortcut-${id}`)?.focus());
  const record = (id: CommandId, event: KeyboardEvent<HTMLButtonElement>) => {
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.key === "Tab" && plain) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && plain) { setRecording(undefined); focusChange(id); return; }
    const chord = chordFromEvent(event.nativeEvent);
    if (!chord) return;
    setRecording(undefined);
    const owner = shortcutOwner(chord, id);
    if (owner) { setConflict({ id, chord, owner }); return; }
    setCommandShortcuts(id, [chord]);
    focusChange(id);
  };

  return <section id="keyboard-shortcuts" className="shortcut-settings" aria-labelledby="keyboard-shortcuts-title">
    <div className="settings-intro">
      <h2 id="keyboard-shortcuts-title">{t({ message: "Keyboard shortcuts", context: "settings view" })}</h2>
      <p>{t({ message: "Shortcuts stay in this browser. Keys without Ctrl, ⌘ or Alt work outside text fields.", context: "settings view" })}</p>
    </div>
    <div className="shortcut-settings-tools">
      <input className="mdbase-field" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
        placeholder={t({ message: "Filter commands", context: "shortcut settings" })} aria-label={t({ message: "Filter commands", context: "shortcut settings" })} />
      {Object.keys(overrides).length > 0 && <button className="mdbase-button is-tertiary" onClick={() => { resetShortcuts(); setConflict(undefined); }}>{t({ message: "Reset all", context: "shortcut settings" })}</button>}
    </div>
    {groups.map(([group, title]) => {
      const ids = shown.filter((id) => ((commandDefinitions[id] as CommandDefinition).group ?? "Other") === group);
      return ids.length > 0 && <div key={group} className="shortcut-group"><h3>{title}</h3><ul className="shortcut-list">{ids.map((id) => {
        const { hint } = commandDefinitions[id] as CommandDefinition;
        const chords = commandShortcuts(id);
        const fixedOwner = conflict?.id === id && (commandDefinitions[conflict.owner] as CommandDefinition).fixed;
        return <li key={id} className="shortcut-row">
          <div className="shortcut-row-label"><span>{label(id)}</span>{hint && <small>{hint}</small>}</div>
          <div className="shortcut-row-keys">
            {recording === id
              ? <button className="shortcut-recorder mdbase-button" data-shortcut-recorder autoFocus onKeyDown={(event) => record(id, event)} onBlur={() => setRecording(undefined)}>
                {t({ message: "Press keys…", context: "shortcut settings" })}
              </button>
              : <button id={`shortcut-${id}`} className="shortcut-change" aria-label={t({ message: `Change shortcut for ${label(id)}`, context: "shortcut settings" })}
                onClick={() => { setConflict(undefined); setRecording(id); }}>
                {chords.length ? chords.map((chord) => <kbd key={chord}>{shortcutLabel(chord)}</kbd>) : <span className="shortcut-unset">{t({ message: "Add shortcut", context: "shortcut settings" })}</span>}
              </button>}
            {isShortcutChanged(id) && <button className="icon-button" aria-label={t({ message: `Restore the default shortcut for ${label(id)}`, context: "shortcut settings" })} title={t({ message: "Restore default", context: "shortcut settings" })}
              onClick={() => { setCommandShortcuts(id, undefined); focusChange(id); }}><Reset aria-hidden="true" /></button>}
            {chords.length > 0 && <button className="icon-button" aria-label={t({ message: `Remove the shortcut for ${label(id)}`, context: "shortcut settings" })} title={t({ message: "Remove shortcut", context: "shortcut settings" })}
              onClick={() => { setCommandShortcuts(id, []); focusChange(id); }}><Remove aria-hidden="true" /></button>}
          </div>
          {conflict?.id === id && <div className="shortcut-conflict" role="alert">
            <p>{fixedOwner
              ? t({ message: `${shortcutLabel(conflict.chord)} is used by ${label(conflict.owner)}, which can’t be changed.`, context: "shortcut settings" })
              : t({ message: `${shortcutLabel(conflict.chord)} is used by ${label(conflict.owner)}.`, context: "shortcut settings" })}</p>
            {!fixedOwner && <button className="mdbase-button" onClick={() => {
              releaseChord(conflict.owner, conflict.chord);
              setCommandShortcuts(id, [conflict.chord]);
              setConflict(undefined);
              focusChange(id);
            }}>{t({ message: "Use it here instead", context: "shortcut settings" })}</button>}
            <button className="mdbase-button is-tertiary" onClick={() => { setConflict(undefined); focusChange(id); }}>{t`Cancel`}</button>
          </div>}
        </li>;
      })}</ul></div>;
    })}
    {shown.length === 0 && <p className="settings-note">{t({ message: "No commands match.", context: "shortcut settings" })}</p>}
  </section>;
}
