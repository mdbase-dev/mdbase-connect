import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prearchiveInventory, type PrearchiveCapture } from "./migration-prearchive-inventory.js";
import { migrationMembershipDigest } from "./migration-rollout.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/migration-prearchive-inventory-v1.json", import.meta.url), "utf8")) as {
  capture: PrearchiveCapture; canonical_ascii: string; inventory_sha256: string;
};
const capture = () => structuredClone(golden.capture);
const rebind = (value: PrearchiveCapture) => {
  value.binding.membership_digest = migrationMembershipDigest(value.members.map(member => [member.view.account_id, member.view.hosted_collections]));
};

describe("complete pre-archive inventory DATA", () => {
  it("matches independently generated Python canonical ASCII bytes and SHA-256", () => {
    const value = capture(), result = prearchiveInventory(value);
    expect(result.bytes.toString("ascii")).toBe(golden.canonical_ascii);
    expect([...result.bytes].every(byte => byte < 128)).toBe(true);
    expect(result.inventory_sha256).toBe(golden.inventory_sha256);
    expect(result.selected).toEqual(value.members[0]!.view.hosted_collections.map(collection_id => ({
      account_id: value.members[0]!.view.account_id, collection_id
    })));
    expect(value).toEqual(golden.capture);
  });
  it("retains terminal/empty membership while terminal export selection is empty", () => {
    const result = prearchiveInventory(capture());
    expect(result.selected).toHaveLength(2);
    expect(JSON.parse(result.bytes.toString("ascii")).members).toHaveLength(3);
  });
  it("is stable from null prefreeze to original freeze and across observation/live-view flags", () => {
    const value = capture();
    value.frozen_at = "2026-10-14T03:00:00.000Z";
    value.observed_at = "2026-10-14T04:00:00.000Z";
    Object.assign(value.members[0]!, { suspended: false });
    Object.assign(value.members[0]!.view, { display_name: "caf\u00e9 \ud83d\ude00 \u007f", future_readiness: true });
    expect(prearchiveInventory(value).inventory_sha256).toBe(golden.inventory_sha256);
  });
  it.each(["account-order", "account-duplicate", "collection-order", "collection-duplicate", "nil", "uppercase",
    "other-cohort", "nonterminal-subset", "terminal-export", "terminal-flag", "terminal-time", "frozen-time", "binding-key", "digest", "account-subset"])("refuses malformed/full-union mismatch: %s", kind => {
    const value = capture(), first = value.members[0]!, terminal = value.members[1]!;
    if (kind === "account-order") value.members = [...value.members].reverse();
    if (kind === "account-duplicate") terminal.view.account_id = first.view.account_id;
    if (kind === "collection-order") first.view.hosted_collections = [...first.view.hosted_collections].reverse();
    if (kind === "collection-duplicate") terminal.view.hosted_collections = [first.view.hosted_collections[0]!];
    if (kind === "nil") first.view.account_id = "00000000-0000-0000-0000-000000000000";
    if (kind === "uppercase") first.view.account_id = "AAAAAAAA-0000-0000-0000-000000000001";
    if (kind === "other-cohort") first.view.cohort = "foreign";
    if (kind === "nonterminal-subset") first.export_collections = [];
    if (kind === "terminal-export") terminal.export_collections = [...terminal.view.hosted_collections];
    if (kind === "terminal-flag") terminal.view.terminal_excluded = false;
    if (kind === "terminal-time") terminal.terminal_excluded_at = "2026-10-14T01:00:00Z";
    if (kind === "frozen-time") value.frozen_at = "2026-02-30T03:00:00.000Z";
    if (kind === "binding-key") Object.assign(value.binding, { sql: "untrusted" });
    if (kind === "digest") value.binding.membership_digest = "0".repeat(64);
    if (kind === "account-subset") value.members = value.members.slice(0, 1);
    expect(() => prearchiveInventory(value)).toThrow();
  });
  it("refuses 851 accounts, 1001 held collections and over1MiB without truncation", () => {
    const accounts = capture();
    accounts.members = Array.from({ length: 851 }, (_, index) => ({ view: {
      account_id: `10000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
      cohort: accounts.binding.batch_id, hosted_collections: [], terminal_excluded: false
    }, terminal_excluded_at: null, export_collections: [] }));
    rebind(accounts);
    expect(() => prearchiveInventory(accounts)).toThrow();
    const collections = capture(); collections.members = [collections.members[0]!];
    collections.members[0]!.view.hosted_collections = Array.from({ length: 1001 }, (_, index) =>
      `20000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`);
    collections.members[0]!.export_collections = [...collections.members[0]!.view.hosted_collections];
    rebind(collections);
    expect(() => prearchiveInventory(collections)).toThrow();
    const large = capture(); Object.assign(large.members[0]!.view, { data: "x".repeat(1024 * 1024) });
    expect(() => prearchiveInventory(large)).toThrow();
  });
  it("recomputed caller DATA is still only a digest, not authenticated inventory", () => {
    const value = capture(); value.members = value.members.slice(0, 1); rebind(value);
    expect(prearchiveInventory(value).inventory_sha256).not.toBe(golden.inventory_sha256);
    // Endpoint authorization MUST reread the complete CP scope independently.
  });
});
