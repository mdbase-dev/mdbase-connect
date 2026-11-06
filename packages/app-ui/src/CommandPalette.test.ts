// @vitest-environment jsdom
import "../test/dialog.js";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandPalette, matchingCommands, shortcutLabel, type Command } from "./CommandPalette.js";

const command = (id: string, group: string, label = id): Command => ({ id, group, label, run: () => {} });

it("puts all contextual actions first without duplicates, including ranked results", () => {
  const commands = [command("search", "navigation"), ...Array.from({ length: 8 }, (_, index) => ({ ...command(`action-${index}`, "commands"), context: "Selected notes", shortcut: "r" }))];
  const matches = matchingCommands(commands, "");
  expect(matches.map(command => command.id)).toEqual([...commands.slice(1).map(command => command.id), "search"]);
  expect(matches.slice(0, 8).every(command => command.group === "context")).toBe(true);
  expect(matchingCommands(commands, "action-7")[0]?.context).toBe("Selected notes");
  act(() => root.render(createElement(CommandPalette, { open: true, commands: [], getResults: () => commands, onClose: () => {} })));
  expect(headings(document.querySelector("dialog")!.outerHTML)[0]).toBe("Selected notes");
  expect(document.querySelector('[role="option"] kbd')?.textContent).toBe("R");
});

const headings = (markup: string) => [...markup.matchAll(/class="mdbase-command-group" role="presentation">(.*?)<\/div>/g)].map((match) => match[1]);

it("keeps an Undo target distinct from the current note's contextual actions", () => {
  const commands = [
    { ...command("undo", "commands"), context: "Deleted note" },
    { ...command("rename", "commands"), context: "Current note" }
  ];
  act(() => root.render(createElement(CommandPalette, { open: true, commands: [], getResults: () => commands, onClose: () => {} })));
  expect(headings(document.querySelector("dialog")!.outerHTML)).toEqual(["Deleted note", "Current note"]);
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
const host = document.body.appendChild(document.createElement("div"));
const root = createRoot(host);
afterEach(() => act(() => root.render(null)));

it("presents sequential shortcuts without turning them into chords", () => {
  expect(shortcutLabel("g c")).toBe("G C");
});

it("presents navigation keys as labels rather than DOM key names", () => {
  expect(shortcutLabel("ArrowDown")).toBe("↓");
  expect(shortcutLabel("ArrowUp")).toBe("↑");
  expect(shortcutLabel("ContextMenu")).toBe("Menu");
});

describe("CommandPalette group labels", () => {
  const commands = [
    ...Array.from({ length: 8 }, (_, i) => command(`tab-${i}`, "tabs")),
    command("settings", "app"),
  ];
  const render = (props: Partial<Parameters<typeof CommandPalette>[0]> = {}) => {
    act(() => root.render(null));
    act(() => root.render(createElement(CommandPalette, {
      open: true, commands, onClose: () => {}, ...props,
    })));
    return document.querySelector("dialog")?.outerHTML ?? "";
  };

  it("describes Enter as running an action, not opening it", () => {
    render({ commands: [command("delete", "actions", "Delete note")] });
    expect(document.querySelector(".mdbase-command-footer")?.textContent).toContain("to run");
    expect(document.querySelector(".mdbase-command-footer")?.textContent).not.toContain("to open");
  });

  it("highlights literal label matches without replacing adapter content", () => {
    render({ commands: [command("field", "collections", "Field [notes] archive")], initialQuery: "field [notes]" });
    expect([...document.querySelectorAll("mark")].map(element => element.textContent)).toEqual(["Field", "[notes]"]);
    render({ commands: [{ ...command("adapter", "collections", "Field notes"), content: createElement("strong", null, createElement("mark", null, "Adapter")) }], initialQuery: "field" });
    expect(document.querySelector("mark")?.textContent).toBe("Adapter");
    render();
    expect(document.querySelector("mark")).toBeNull();
  });

  it("keeps existing headings when no callback is supplied", () => {
    expect(headings(render())).toEqual(["tabs", "app"]);
  });

  it("translates headings using stable IDs, without changing showAll or commands", () => {
    const groupLabel = vi.fn((group: string) => group === "tabs" ? "開いているタブ" : "アプリ");
    const markup = render({ groupLabel, showAll: ["tabs"] });
    expect(headings(markup)).toEqual(["開いているタブ", "アプリ"]);
    expect(groupLabel.mock.calls).toEqual([["tabs"], ["app"]]);
    expect(markup.match(/role="option"/g)).toHaveLength(9);
    expect(markup).toContain("tab-7");
    expect(commands.every((c) => c.group === (c.id === "settings" ? "app" : "tabs"))).toBe(true);
    expect(matchingCommands(commands, "tabs").map((c) => c.id)).toEqual(commands.slice(0, 8).map((c) => c.id));
    expect(matchingCommands(commands, "開いているタブ")).toEqual([]);
    // A translated display value is not a showAll ID.
    expect(render({ groupLabel, showAll: ["開いているタブ"] }).match(/role="option"/g)).toHaveLength(7);
  });

  it("does not merge distinct groups whose translated headings are identical", () => {
    expect(headings(render({ groupLabel: () => "項目" }))).toEqual(["項目", "項目"]);
  });

  it("renders the current presentation on each render and stays closed when requested", () => {
    expect(headings(render({ groupLabel: (group) => group === "tabs" ? "Offene Tabs" : "App" }))).toEqual(["Offene Tabs", "App"]);
    expect(headings(render({ groupLabel: (group) => group === "tabs" ? "Onglets ouverts" : "Appli" }))).toEqual(["Onglets ouverts", "Appli"]);
    const groupLabel = vi.fn((group: string) => group);
    expect(render({ open: false, groupLabel })).toBe("");
    expect(groupLabel).not.toHaveBeenCalled();
  });
});

describe("matchingCommands", () => {
  const commands = [
    ...Array.from({ length: 8 }, (_, i) => command(`tab-${i}`, "Open tabs")),
    ...Array.from({ length: 8 }, (_, i) => command(`source-${i}`, "Sources", `Source ${i}`)),
    command("settings", "App", "Open settings")
  ];

  it("browses a few of each group, and all of the groups asked for", () => {
    const shown = matchingCommands(commands, "", ["Open tabs"]);
    expect(shown.filter((c) => c.group === "Open tabs")).toHaveLength(8);
    expect(shown.filter((c) => c.group === "Sources")).toHaveLength(6);
  });

  it("matches every term and keeps the groups together", () => {
    expect(matchingCommands(commands, "source 3").map((c) => c.id)).toEqual(["source-3"]);
    expect(matchingCommands(commands, "open settings").map((c) => c.id)).toEqual(["settings"]);
  });

  it("matches nonadjacent terms and retains label matches before the search cap", () => {
    const commands = [
      ...Array.from({ length: 50 }, (_, index) => ({ ...command(`collection-${index}`, "collections"), detail: "Travel laptop" })),
      command("computer", "computers", "Travel field laptop"),
    ];
    const matches = matchingCommands(commands, "travel laptop");
    expect(matches).toHaveLength(40);
    expect(matches[0]?.id).toBe("computer");
  });
});
