import { describe, expect, it, vi } from "vitest";
import { buildEditorCommands, commandDefinitions, filterCommands, matchesCommandShortcut, rememberCommand } from "./editor-commands";
import { loadPreferences, savePreferences, defaultPreferences } from "./preferences";
import { loadPinnedNotes, savePinnedNotes } from "./note-list-view";

describe("editor command registry", () => {
  it("binds one canonical label and shortcut per supported action", () => {
    const handlers = Object.fromEntries(Object.keys(commandDefinitions).map((id) => [id, vi.fn()]));
    const commands = buildEditorCommands(handlers);
    expect(commands.map((entry) => entry.id)).toEqual(Object.keys(commandDefinitions));
    for (const entry of commands) { expect(entry.label).toBe(commandDefinitions[entry.id as keyof typeof commandDefinitions].label); entry.run(); expect(handlers[entry.id]).toHaveBeenCalledOnce(); }
    expect(buildEditorCommands({})).toEqual([]);
  });
  it("fuzzy matches tokens and puts recent commands first without hiding other commands", () => {
    const commands = buildEditorCommands({ "new-note": vi.fn(), "copy-path": vi.fn(), focus: vi.fn() });
    expect(filterCommands(commands, "cpy pth").map((entry) => entry.id)).toEqual(["copy-path"]);
    rememberCommand("focus"); rememberCommand("new-note"); rememberCommand("focus");
    expect(filterCommands(commands, "").map((entry) => entry.id)).toEqual(["focus", "new-note", "copy-path"]);
    expect(filterCommands(commands, "missing")).toEqual([]);
  });
  it("uses registry shortcuts for both Control and Command, with exact modifiers", () => {
    const event = { key: "P", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
    expect(matchesCommandShortcut("command-palette", event)).toBe(true);
    expect(matchesCommandShortcut("quick-open", event)).toBe(false);
    expect(matchesCommandShortcut("command-palette", { ...event, ctrlKey: false, metaKey: true })).toBe(true);
    expect(matchesCommandShortcut("command-palette", { ...event, altKey: true })).toBe(false);
    expect(matchesCommandShortcut("focus", { ...event, key: "F" })).toBe(true);
  });
  it("persists focus/typewriter preferences and collection-scoped pins", () => {
    savePreferences({ ...defaultPreferences, focusMode: true, typewriterScrolling: true });
    expect(loadPreferences()).toMatchObject({ focusMode: true, typewriterScrolling: true });
    savePinnedNotes("first", ["Notes/test.md"]);
    expect(loadPinnedNotes("first")).toEqual(["Notes/test.md"]);
    expect(loadPinnedNotes("second")).toEqual([]);
    localStorage.setItem("mdbase-editor:preferences", "{}");
    expect(loadPreferences()).toEqual(defaultPreferences);
  });
});
