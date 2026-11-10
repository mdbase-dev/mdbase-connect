import { describe, expect, it, vi } from "vitest";
import { buildEditorCommands, commandDefinitions, filterCommands, matchesCommandShortcut, rememberCommand } from "./editor-commands";
import { loadPreferences, savePreferences, defaultPreferences } from "./preferences";
import { loadPinnedNotes, savePinnedNotes } from "./note-list-view";

describe("editor command registry", () => {
  it("puts live Undo and the actual action context ahead of recent global commands", () => {
    const commands = buildEditorCommands(Object.fromEntries(Object.keys(commandDefinitions).map(id => [id, vi.fn()])));
    commands.find(entry => entry.id === "rename")!.context = "Garden notes";
    rememberCommand("new-note");
    expect(filterCommands(commands, "").slice(0, 2).map(entry => entry.id)).toEqual(["undo", "rename"]);
    expect(filterCommands(commands, "rename")[0].context).toBe("Garden notes");
    expect(filterCommands([{ id: "pin", label: "Pin", run: vi.fn() }, { id: "unpin", label: "Unpin", context: "Garden notes", run: vi.fn() }], "pin")[0].id).toBe("pin");
  });
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
  it("shares rename aliases and the list undo chord", () => {
    const event = { key: "r", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(matchesCommandShortcut("rename", event)).toBe(true);
    expect(matchesCommandShortcut("rename", { ...event, key: "F2" })).toBe(true);
    expect(matchesCommandShortcut("rename", { ...event, ctrlKey: true })).toBe(false);
    expect(matchesCommandShortcut("undo", { ...event, key: "z", ctrlKey: true })).toBe(true);
    expect(matchesCommandShortcut("undo", { ...event, key: "z", metaKey: true })).toBe(true);
    expect(matchesCommandShortcut("undo", { ...event, key: "z", ctrlKey: true, shiftKey: true })).toBe(false);
  });
  it("keeps shared K semantics, sequence prefixes and list keys in the registry", () => {
    const event = { key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    expect(matchesCommandShortcut("command-palette", event)).toBe(true);
    expect(matchesCommandShortcut("command-palette", { ...event, shiftKey: true })).toBe(false);
    expect(matchesCommandShortcut("types", { ...event, ctrlKey: false, key: "t" })).toBe(false);
    expect(matchesCommandShortcut("types", { ...event, ctrlKey: false, key: "t" }, "g")).toBe(true);
    expect(matchesCommandShortcut("new-note", { ...event, ctrlKey: false, key: "c" })).toBe(true);
    expect(matchesCommandShortcut("peek", { ...event, ctrlKey: false, key: " " })).toBe(true);
    expect(Object.values(commandDefinitions).some(entry => "shortcut" in entry && entry.shortcut.toLowerCase() === "x")).toBe(false);
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
