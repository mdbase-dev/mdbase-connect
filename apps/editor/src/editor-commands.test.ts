import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEditorCommands, chordFromEvent, command, commandDefinitions, commandShortcuts, filterCommands, isShortcutChanged, matchesCommandShortcut, releaseChord, rememberCommand, resetShortcuts, sequencePrefixes, setCommandShortcuts, shortcutOwner } from "./editor-commands";
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

describe("shortcuts on this device", () => {
  const press = { key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  afterEach(() => resetShortcuts());

  it("replaces a command's chords, persists them and restores the registry's", () => {
    setCommandShortcuts("bold", ["mod+shift+B"]);
    expect(commandShortcuts("bold")).toEqual(["mod+shift+B"]);
    expect(matchesCommandShortcut("bold", { ...press, key: "B", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(matchesCommandShortcut("bold", { ...press, key: "b", ctrlKey: true })).toBe(false);
    expect(command("bold", vi.fn())).toMatchObject({ shortcut: "mod+shift+B", aliases: [] });
    expect(JSON.parse(localStorage.getItem("mdbase-editor:shortcuts")!)).toEqual({ bold: ["mod+shift+B"] });
    setCommandShortcuts("command-palette", []);
    expect(command("command-palette", vi.fn()).shortcut).toBeUndefined();
    expect(matchesCommandShortcut("command-palette", { ...press, key: "k", ctrlKey: true })).toBe(false);
    setCommandShortcuts("bold", ["Mod+B"]);
    expect(isShortcutChanged("bold")).toBe(false);
    setCommandShortcuts("command-palette", undefined);
    expect(commandShortcuts("command-palette")).toEqual(["mod+K", "mod+shift+P"]);
    expect(localStorage.getItem("mdbase-editor:shortcuts")).toBeNull();
  });

  it("loads only valid overrides of commands that can change", async () => {
    localStorage.setItem("mdbase-editor:shortcuts", JSON.stringify({ pin: ["alt+P"], "find-text": ["mod+G"], missing: ["X"], bold: "mod+B", italic: [3] }));
    vi.resetModules();
    const fresh = await import("./editor-commands");
    expect(fresh.commandShortcuts("pin")).toEqual(["alt+P"]);
    expect(fresh.commandShortcuts("find-text")).toEqual(["mod+F"]);
    expect(fresh.commandShortcuts("bold")).toEqual(["mod+B"]);
    expect(fresh.commandShortcuts("italic")).toEqual(["mod+I"]);
    localStorage.setItem("mdbase-editor:shortcuts", "not json");
    vi.resetModules();
    expect((await import("./editor-commands")).commandShortcuts("pin")).toEqual([]);
  });

  it("records chords in the registry's spelling on each platform", () => {
    const platform = vi.spyOn(navigator, "platform", "get");
    platform.mockReturnValue("Linux x86_64");
    expect(chordFromEvent({ ...press, key: "B", ctrlKey: true, shiftKey: true })).toBe("mod+shift+B");
    expect(chordFromEvent({ ...press, key: "?", shiftKey: true })).toBe("?");
    expect(chordFromEvent({ ...press, key: " " })).toBe("Space");
    expect(chordFromEvent({ ...press, key: "ArrowLeft", altKey: true, shiftKey: true })).toBe("alt+shift+ArrowLeft");
    expect(chordFromEvent({ ...press, key: "Control", ctrlKey: true })).toBeUndefined();
    platform.mockReturnValue("MacIntel");
    expect(chordFromEvent({ ...press, key: "k", metaKey: true })).toBe("mod+K");
    expect(chordFromEvent({ ...press, key: "k", ctrlKey: true })).toBe("ctrl+K");
    // Option+J types ∆ on a Mac, so the physical key names the chord and matches it.
    const optionJ = { ...press, key: "∆", code: "KeyJ", altKey: true };
    expect(chordFromEvent(optionJ)).toBe("alt+J");
    expect(matchesCommandShortcut("next-note", optionJ)).toBe(true);
    expect(matchesCommandShortcut("comment", { ...press, key: "µ", code: "KeyM", altKey: true, metaKey: true })).toBe(true);
  });

  it("finds the command that already has a chord, including one that starts a sequence", () => {
    expect(shortcutOwner("Mod+b", "italic")).toBe("bold");
    expect(shortcutOwner("mod+B", "bold")).toBeUndefined();
    expect(shortcutOwner("G", "pin")).toBe("notes");
    expect(shortcutOwner("mod+shift+P", "pin")).toBe("command-palette");
    releaseChord("command-palette", "mod+shift+P");
    expect(commandShortcuts("command-palette")).toEqual(["mod+K"]);
    expect(sequencePrefixes()).toEqual(new Set(["g"]));
    for (const id of ["notes", "types", "settings"] as const) releaseChord(id, "G");
    expect(sequencePrefixes()).toEqual(new Set());
  });
});
