import { describe, expect, it } from "vitest";
import type { NoteVersion } from "./model";
import { dayLabel, historyTimeline, restoreChangeSummary, versionAuthor, versionChange } from "./note-history";

const ME = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const OTHER = "11111111-2222-4333-8444-555555555555";
const DEVICE = "2d7e9a41-6c3b-4f18-9a05-c8e1b2d3f467";
const minute = 60_000;
const noon = new Date(2026, 10, 17, 12, 0).getTime();

function version(seq: number, time: number, overrides: Partial<NoteVersion> = {}): NoteVersion {
  return {
    seq, time, kind: "edited", path: "notes/a.md", revision: `sha256:${"0".repeat(64)}`, source: "api",
    author: { account: ME, device: DEVICE }, deviceKind: "desktop", ...overrides
  };
}

describe("historyTimeline", () => {
  it("collapses one author's run of edits, each within ten minutes of the next", () => {
    const days = historyTimeline([
      version(9, noon), version(8, noon - 6 * minute), version(7, noon - 12 * minute), version(6, noon - 30 * minute)
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]!.rows.map((row) => [row.version.seq, row.saves, row.since])).toEqual([
      [9, 3, noon - 12 * minute],
      [6, 1, undefined]
    ]);
  });

  it("keeps different authors, apps and outside edits apart", () => {
    const days = historyTimeline([
      version(5, noon),
      version(4, noon - minute, { author: { account: OTHER, device: DEVICE } }),
      version(3, noon - 2 * minute, { app: "dev.mdbase.editor", author: { account: ME, device: DEVICE, grant: OTHER } }),
      version(2, noon - 3 * minute, { source: "external" }),
      version(1, noon - 4 * minute, { source: "external" })
    ]);
    expect(days[0]!.rows.map((row) => [row.version.seq, row.saves])).toEqual([[5, 1], [4, 1], [3, 1], [2, 2]]);
  });

  it("gives creations, moves and deletions rows of their own", () => {
    const days = historyTimeline([
      version(4, noon), version(3, noon - minute, { kind: "moved" }), version(2, noon - 2 * minute), version(1, noon - 3 * minute, { kind: "created" })
    ]);
    expect(days[0]!.rows.map((row) => row.version.kind)).toEqual(["edited", "moved", "edited", "created"]);
  });

  it("keeps one section per day when a late-synced edit's capture time is out of log order", () => {
    const midnight = new Date(2026, 10, 17).getTime();
    // 3 was captured yesterday but synced after 2: its log position is newer.
    const days = historyTimeline([version(4, midnight + 30 * minute), version(3, midnight - 60 * minute),
      version(2, midnight + 20 * minute), version(1, midnight - 61 * minute)]);
    expect(days.map((day) => [day.key, day.rows.map((row) => [row.version.seq, row.saves])])).toEqual([
      ["2026-11-17", [[4, 1], [2, 1]]],
      ["2026-11-16", [[3, 1], [1, 1]]]
    ]);
  });

  it("groups by local day and never collapses across midnight", () => {
    const midnight = new Date(2026, 10, 17).getTime();
    const days = historyTimeline([version(2, midnight + 2 * minute), version(1, midnight - 2 * minute)]);
    expect(days.map((day) => [day.key, day.rows.length])).toEqual([["2026-11-17", 1], ["2026-11-16", 1]]);
  });
});

describe("dayLabel", () => {
  it("names today and yesterday, and dates the rest", () => {
    const now = new Date(noon);
    expect(dayLabel("2026-11-17", now)).toBe("Today");
    expect(dayLabel("2026-11-16", now)).toBe("Yesterday");
    expect(dayLabel("2026-11-02", now)).toBe("Monday, November 2");
    expect(dayLabel("2025-11-02", now)).toBe("Sunday, November 2, 2025");
  });
});

describe("versionAuthor", () => {
  it("names the app for grant writes, and says whose they were when it knows", () => {
    const viaEditor = version(1, noon, { app: "dev.mdbase.editor", author: { account: ME, device: DEVICE, grant: OTHER } });
    expect(versionAuthor(viaEditor, ME)).toBe("You, in mdbase editor");
    expect(versionAuthor(viaEditor, OTHER)).toBe("A collaborator, in mdbase editor");
    expect(versionAuthor(viaEditor)).toBe("mdbase editor");
    expect(versionAuthor({ ...viaEditor, app: "dev.example.tasks" }, ME)).toBe("You, in dev.example.tasks");
  });

  it("attributes the hosted device's writes to the grant's account", () => {
    const hosted = version(1, noon, {
      app: "dev.mdbase.editor", deviceKind: "hosted",
      author: { account: "00000000-0000-0000-0000-000000000000", device: DEVICE, grant: OTHER, grantAccount: ME }
    });
    expect(versionAuthor(hosted, ME)).toBe("You, in mdbase editor");
  });

  it("names your own devices by kind, and others as a collaborator", () => {
    expect(versionAuthor(version(1, noon), ME)).toBe("You, on desktop");
    expect(versionAuthor(version(1, noon, { deviceKind: "mobile" }), ME)).toBe("You, on mobile");
    expect(versionAuthor(version(1, noon, { deviceKind: "cli" }), ME)).toBe("You, from the command line");
    expect(versionAuthor(version(1, noon, { deviceKind: "unknown" }), ME)).toBe("You, on another device");
    expect(versionAuthor(version(1, noon), OTHER)).toBe("A collaborator, on desktop");
    expect(versionAuthor(version(1, noon))).toBe("On desktop");
  });

  it("says when a version was edited outside mdbase", () => {
    expect(versionAuthor(version(1, noon, { source: "external" }), ME)).toBe("Edited outside mdbase");
  });
});

describe("versionChange", () => {
  it("describes everything but a plain edit", () => {
    expect(versionChange(version(1, noon))).toBeUndefined();
    expect(versionChange(version(1, noon, { kind: "created" }))).toBe("Created");
    expect(versionChange(version(1, noon, { kind: "moved", path: "archive/a.md" }))).toBe("Moved to archive/a.md");
    expect(versionChange(version(1, noon, { kind: "deleted" }))).toBe("Deleted");
  });
});

describe("restoreChangeSummary", () => {
  it("counts lines added and removed and returns a capped preview", () => {
    expect(restoreChangeSummary("same", "same")).toEqual({ added: 0, removed: 0, preview: [], omitted: 0 });
    expect(restoreChangeSummary("a\nnow\nc", "a\nthen 1\nthen 2\nc")).toEqual({
      added: 2,
      removed: 1,
      preview: [
        { kind: "removed", text: "now" },
        { kind: "added", text: "then 1" },
        { kind: "added", text: "then 2" }
      ],
      omitted: 0
    });
    const capped = restoreChangeSummary("1\n2\n3\n4", "a\nb\nc\nd", 3);
    expect(capped.added).toBe(4);
    expect(capped.removed).toBe(4);
    expect(capped.preview).toHaveLength(3);
    expect(capped.omitted).toBe(5);
  });
});
