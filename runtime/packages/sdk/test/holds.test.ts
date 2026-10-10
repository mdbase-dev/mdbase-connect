import { describe, expect, it } from "vitest";
import { HOLD_TITLE, describeHold, holdCompareLink, holdNotice, parseHoldCompareLink, syncStatusText } from "../src/holds.js";
import type { Hold, HoldReason, SyncStatus } from "../src/wire.js";

const COLL = "0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11";
const ID = "018f6d2e-1c3a-7b4d-9e1f-2a3b4c5d6e7f";
const hold = (reason: HoldReason, more: Partial<Hold> = {}): Hold => ({ id: ID, path: "notes/a.md", reason, since: 1, mine: "mine", theirs: "theirs", saves: 2, ...more });

describe("hold presentation", () => {
  it("reads as protection with a plain cause, actions from the wire vocabulary, and a compare link", () => {
    const p = describeHold(hold("conflict"), { collectionId: COLL });
    expect(p.title).toBe(HOLD_TITLE);
    expect(p.title).not.toMatch(/stuck/i);
    expect(p.cause).toMatch(/another device/);
    expect(p.actions.map((a) => a.action)).toEqual(["keep_mine", "take_theirs", "compare", "keep_both"]);
    expect(p.actions.find((a) => a.action === "take_theirs")).toMatchObject({ resolution: "take_theirs", needs: "records.edit", discardsMine: true });
    expect(p.actions.find((a) => a.action === "compare")?.resolution).toBeUndefined();
    expect(p.reversible).toBe(true);
    expect(p.compareLink).toBe(`mdbase://hold/compare?collection=${COLL}&id=${ID}`);
    expect(p.saves).toBe(2);
  });
  it("covers every wire reason with a cause and at least one resolution", () => {
    for (const reason of ["conflict", "unknown_provenance", "deleted_elsewhere", "read_only", "editor_busy", "suspect_write"] as const) {
      const p = describeHold(hold(reason), { collectionId: COLL });
      expect(p.cause.length).toBeGreaterThan(20);
      expect(p.detail.length).toBeGreaterThan(20);
      expect(p.actions.some((a) => a.resolution)).toBe(true);
    }
  });
  it("drops compare and take-theirs when nothing confirmed exists, and delete without the capability", () => {
    const gone = describeHold(hold("deleted_elsewhere", { theirs: undefined }), { collectionId: COLL });
    expect(gone.hasTheirs).toBe(false);
    expect(gone.compareLink).toBeNull();
    expect(gone.actions.map((a) => a.action)).toEqual(["keep_mine", "delete"]);
    const viewer = describeHold(hold("deleted_elsewhere", { theirs: undefined }), { collectionId: COLL, capabilities: ["records.edit"] });
    expect(viewer.actions.map((a) => a.action)).toEqual(["keep_mine"]);
    const noMerge = describeHold(hold("conflict"), { collectionId: COLL, canCompare: false });
    expect(noMerge.actions.map((a) => a.action)).toEqual(["keep_mine", "take_theirs", "keep_both"]);
    expect(noMerge.compareLink).toBeNull();
  });
  it("compare links round-trip and reject anything else", () => {
    expect(parseHoldCompareLink(holdCompareLink(COLL.toUpperCase(), ID))).toEqual({ collectionId: COLL, id: ID });
    expect(parseHoldCompareLink("https://example.com/?collection=x")).toBeNull();
    expect(parseHoldCompareLink("mdbase://hold/compare?collection=nope&id=" + ID)).toBeNull();
    expect(parseHoldCompareLink("mdbase://hold/compare?id=" + ID)).toBeNull();
    expect(() => holdCompareLink("x", ID)).toThrow();
  });
  it("banner and status text", () => {
    expect(holdNotice([])).toBeNull();
    expect(holdNotice([hold("conflict")])).toBe(`${HOLD_TITLE}: notes/a.md is waiting for your choice.`);
    expect(holdNotice([hold("conflict"), hold("read_only", { path: "b.md" })])).toBe(`${HOLD_TITLE}: 2 files are waiting for your choice.`);
    const s: SyncStatus = { mode: "synced", confirmedThrough: 42, headKnown: 42, pending: 3, holds: 1, unresolved: 0, connection: "online", incidents: [] };
    expect(syncStatusText(s)).toBe("Confirmed through 42, plus 3 pending, plus 1 held");
    expect(syncStatusText({ ...s, mode: "local_only" })).toBe("Saved on this device, plus 3 pending, plus 1 held");
  });
});
