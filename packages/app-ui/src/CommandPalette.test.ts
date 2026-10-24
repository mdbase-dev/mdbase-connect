import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette, matchingCommands, type Command } from "./CommandPalette.js";

const command = (id: string, group: string, label = id): Command => ({ id, group, label, run: () => {} });

const headings = (markup: string) => [...markup.matchAll(/class="mdbase-command-group" role="presentation">(.*?)<\/div>/g)].map((match) => match[1]);

describe("CommandPalette group labels", () => {
  const commands = [
    ...Array.from({ length: 8 }, (_, i) => command(`tab-${i}`, "tabs")),
    command("settings", "app"),
  ];
  const render = (props: Partial<Parameters<typeof CommandPalette>[0]> = {}) => renderToStaticMarkup(createElement(CommandPalette, {
    open: true, commands, onClose: () => {}, ...props,
  }));

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
});
