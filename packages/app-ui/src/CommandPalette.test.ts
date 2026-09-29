import { describe, expect, it } from "vitest";

import { matchingCommands, type Command } from "./CommandPalette.js";

const command = (id: string, group: string, label = id): Command => ({ id, group, label, run: () => {} });

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
