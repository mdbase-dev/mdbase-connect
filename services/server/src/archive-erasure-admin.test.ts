import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DatabasePool } from "./database-types.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { drainArchiveErasures } from "./archive-erasure-admin.js";
import { runAuthAdminCommand } from "./auth-admin.js";

const jobs = vi.hoisted(() => ({ accounts: vi.fn(), provider: vi.fn() }));
vi.mock("./account-management.js", async original => ({ ...await original<object>(), drainDeferredAccountDeletions: jobs.accounts }));
vi.mock("./hosted-capability-lifecycle.js", async original => ({ ...await original<object>(), ProviderRevocationWorker: class { drain = jobs.provider; } }));
const sha = "a".repeat(40), operation = "12345678-1234-1234-1234-123456789abc";
const input = () => ({ cohort: "test-archive", expectedRevision: sha, operationId: operation, actor: "synthetic", reason: "fixture" });
const empty = () => ({ revision: "7", unfrozen: true, accounts_empty: true, collections_empty: true, revocations_empty: true });
function fixture(rows = [empty(), empty()]) {
  const queries = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.startsWith("SELECT membership_revision") ? [rows.shift()] : [] }));
  const release = vi.fn();
  const db = { connect: vi.fn(async () => ({ query: queries, release })), query: vi.fn(async () => ({ rows: [] })) } as unknown as DatabasePool;
  return { db, queries, release, provider: {} as HostedProviderClient };
}
beforeEach(() => { jobs.accounts.mockReset().mockResolvedValue(0); jobs.provider.mockReset().mockResolvedValue(0); });
describe("fixed service-local pre-freeze drain (mock IO, not erasure/runtime qualification)", () => {
  it.each(["expectedRevision", "cohort", "operationId", "actor", "reason"])("invalid %s refuses before DB or jobs", async field => {
    const f = fixture(), args = { ...input(), [field]: "" };
    await expect(drainArchiveErasures(f.db, f.provider, sha, args)).rejects.toThrow("input_or_revision_invalid");
    expect(f.db.connect).not.toHaveBeenCalled(); expect(jobs.accounts).not.toHaveBeenCalled();
  });
  it("wrong runtime and absent provider do not become a bypass", async () => {
    const f = fixture();
    await expect(drainArchiveErasures(f.db, f.provider, "b".repeat(40), input())).rejects.toThrow("input_or_revision_invalid");
    await expect(drainArchiveErasures(f.db, undefined, sha, input())).rejects.toThrow("provider_unconfigured");
    expect(f.db.connect).not.toHaveBeenCalled();
  });
  it("already-frozen refuses before auditing or erasure", async () => {
    const f = fixture([{ ...empty(), unfrozen: false }]);
    await expect(drainArchiveErasures(f.db, f.provider, sha, input())).rejects.toThrow("cohort_frozen");
    expect(f.db.query).not.toHaveBeenCalled(); expect(jobs.accounts).not.toHaveBeenCalled(); expect(jobs.provider).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it.each(["accounts_empty", "collections_empty", "revocations_empty"])("%s false after a zero drain still refuses", async field => {
    const f = fixture([empty(), { ...empty(), [field]: false }]);
    await expect(drainArchiveErasures(f.db, f.provider, sha, input())).rejects.toThrow("queue_not_empty");
    expect(jobs.accounts).toHaveBeenCalledWith(f.db, 25); expect(jobs.provider).toHaveBeenCalledWith(5);
    expect(f.db.query).toHaveBeenCalledTimes(1); expect(f.release).toHaveBeenCalledTimes(2);
  });
  it("concurrent freeze and malformed bool are refusals, not optimistic observations", async () => {
    const f = fixture([empty(), { ...empty(), unfrozen: false }]);
    await expect(drainArchiveErasures(f.db, f.provider, sha, input())).rejects.toThrow("cohort_frozen");
    const g = fixture([{ ...empty(), accounts_empty: "true" as unknown as boolean }]);
    await expect(drainArchiveErasures(g.db, g.provider, sha, input())).rejects.toThrow("observation_invalid");
    expect(jobs.accounts).toHaveBeenCalledTimes(1);
  });
  it("database failures export fixed refusal, never raw diagnostic content", async () => {
    const f = fixture(); f.queries.mockRejectedValueOnce(new Error("private diagnostic"));
    await expect(drainArchiveErasures(f.db, f.provider, sha, input())).rejects.toThrow(/^archive_erasure_check_failed$/);
    expect(f.release).toHaveBeenCalledTimes(1); expect(jobs.accounts).not.toHaveBeenCalled();
  });
  it("captures original scalar arguments before awaits and emits only the closed metadata result", async () => {
    const f = fixture(), args = input();
    jobs.accounts.mockImplementationOnce(async () => { args.cohort = "changed"; args.operationId = "changed"; return 1; });
    jobs.provider.mockResolvedValueOnce(2);
    const result = await drainArchiveErasures(f.db, f.provider, sha, args);
    expect(result).toEqual({ schema: "mdbase-archive-erasure-preflight/v1", operation_id: operation, runtime_revision: sha,
      membership_revision: "7", unfrozen: true, queues_empty: { deferred_accounts: true, provider_collections: true, provider_revocations: true },
      completed: { accounts: 1, provider_jobs: 2 } });
    expect(f.queries.mock.calls.filter(([sql]) => sql.startsWith("SELECT membership_revision")).every(([, values]) => values?.[0] === "test-archive")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic"); expect(JSON.stringify(result)).not.toContain("fixture");
  });
  it("existing encoded admin request and strict flags dispatch the same bounded implementation", async () => {
    const f = fixture(), argv = ["archive", "drain-deletions", "--cohort", "test-archive", "--expected-revision", sha,
      "--operation-id", operation, "--actor", "synthetic", "--reason", "fixture"];
    const context = { db: f.db, hostedProvider: f.provider, runtimeRevision: sha, defaultRegistrationMode: "closed" as const };
    await expect(runAuthAdminCommand(["request", Buffer.from(JSON.stringify(argv)).toString("base64url")], context)).resolves.toMatchObject({ operation_id: operation });
    await expect(runAuthAdminCommand([...argv, "--limit", "100"], context)).rejects.toThrow("Unknown option");
    await expect(runAuthAdminCommand([...argv, "--cohort", "other"], context)).rejects.toThrow("only once");
    expect(jobs.accounts).toHaveBeenCalledTimes(1);
  });
});
