import { describe, expect, it, vi } from "vitest";
import type { DatabaseQueryable } from "../../../database-types.js";
import { legacyTimer, readHostedLegacyTimers, type HostedLegacyTimerRow, type HostedLegacyTimerCursor } from "./hosted-copy.js";

const collection = "10000000-0000-4000-8000-000000000001";
const grant = "20000000-0000-4000-8000-000000000002";
const migration = "30000000-0000-4000-8000-000000000003";
const time = "2030-01-01T12:13:14.123456Z";
function row(status = "scheduled"): HostedLegacyTimerRow {
  const runtime_id = `connect:${grant}:reminders:timer.6162`;
  const fired_at = status === "fired" ? time : null;
  return { runtime_namespace: `connect-hosted:${collection}:notifications`, runtime_id,
    generation: "7", status, fire_at: time, created_at: time, updated_at: time, fired_at, leased: false,
    record_json: JSON.stringify({ id: runtime_id, generation: 7, status, fire_at: time,
      created_at: time, updated_at: time, fired_at,
      event_contract: { id: "test/timer", version: "1", digest: `sha256:${"a".repeat(64)}` },
      event_source: { application: "original", implementation: "timer", version: "1" },
      source_uri: "app:test", subject: "ab", data: { grant_id: grant, namespace: "reminders",
        timer_id: "ab", criterion_id: "reminder", data: { nested: [true, null, 0.1] } } }) };
}
function source(rows: unknown[]) {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { provider: { query } as unknown as DatabaseQueryable, query };
}
const metadata = { schema_version: 2, state: "migrating", migration_id: migration,
  started_at: time, head: "9223372036854775807", unsettled: false };

describe("complete hosted timer source DATA", () => {
  it.each(["scheduled", "fired", "cancelled"])("preserves original %s identity/generation/full raw record/microseconds", status => {
    const original = row(status);
    const decoded = legacyTimer(original);
    expect(decoded).toMatchObject({ generation: "7", status, fire_at: time, created_at: time,
      updated_at: time, fired_at: original.fired_at, runtime_id: original.runtime_id, record_json: original.record_json });
  });
  it.each([
    { generation: undefined }, { generation: "9007199254740992" }, { generation: "0" },
    { status: "firing" }, { status: "unknown" }, { leased: true }, { leased: undefined },
    { runtime_id: "replacement" }, { fire_at: "2030-01-01T12:13:14.123457Z" },
    { created_at: "2030-02-30T00:00:00Z" }, { updated_at: "2030-01-01T12:13:14.1234561Z" },
    { record_json: undefined }, { record_json: "{}" }, { fired_at: time }
  ])("refuses incomplete/changed/unsettled input %#", change => {
    expect(() => legacyTimer({ ...row(), ...change })).toThrow("Legacy timer snapshot refused");
  });
  it.each(["scheduled", "fired"])("preserves original nanoseconds for %s without source normalization", status => {
    const original = row(status);
    const nano = "2030-01-01T12:13:14.123456789Z";
    const record = JSON.parse(original.record_json);
    record.fire_at = nano;
    record.created_at = nano;
    record.updated_at = nano;
    record.fired_at = status === "fired" ? nano : null;
    original.created_at = nano;
    original.updated_at = nano;
    original.fired_at = record.fired_at;
    original.record_json = JSON.stringify(record);
    const decoded = legacyTimer(original);
    expect(decoded).toMatchObject({ fire_at: nano, created_at: nano, updated_at: nano,
      fired_at: record.fired_at, record_json: original.record_json });
    expect(original.fire_at).toBe(time);
  });
  it("does not parse or hash lossy original JSON numbers", () => {
    for (const number of ["9007199254740993", "0.10000000000000000001", "1e309", "-0"]) {
      const original = row();
      original.record_json = original.record_json.replace("0.1", number);
      expect(() => legacyTimer(original)).toThrow("lossy JSON number");
    }
  });
  it("preserves equivalent exact decimal exponent syntax", () => {
    const original = row();
    original.record_json = original.record_json.replace("0.1", "1e-1");
    expect(legacyTimer(original).data).toEqual({ nested: [true, null, 0.1] });
  });
  it("requires original contract/source/subject and wrapped data fields", () => {
    for (const key of ["event_contract", "event_source", "source_uri", "subject"]) {
      const original = row();
      const record = JSON.parse(original.record_json);
      delete record[key];
      original.record_json = JSON.stringify(record);
      expect(() => legacyTimer(original)).toThrow("incomplete record");
    }
  });
  it("reads one original frozen snapshot, complete terminal rows and exact fence DATA", async () => {
    const { provider, query } = source(["scheduled", "fired", "cancelled"].map(status => ({ ...metadata, ...row(status) })));
    const result = await readHostedLegacyTimers(provider, collection);
    expect(result.timers.map(t => t.status)).toEqual(["scheduled", "fired", "cancelled"]);
    expect(result.skipped).toBe(0);
    expect(result.fence).toEqual({ collection_id: collection, migration_id: migration, started_at: time, head: metadata.head });
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0];
    expect(sql.trimStart()).toMatch(/^SELECT /);
    expect(sql).toContain("LIMIT 65");
    expect(sql).toContain("t.record_json::text");
    expect(params).toEqual([collection, `connect-hosted:${collection}:notifications`, null]);
  });
  it("returns genuine empty inventory only with complete frozen/schema2 observation", async () => {
    const { provider } = source([{ ...metadata, runtime_id: null }]);
    expect((await readHostedLegacyTimers(provider, collection)).timers).toEqual([]);
  });
  it.each([[], [{ ...metadata, schema_version: 1 }], [{ ...metadata, state: "active" }],
    [{ ...metadata, migration_id: null }], [{ ...metadata, unsettled: true }]].map(rows => ({ rows })))("refuses unavailable original point %#", async ({ rows }) => {
    const { provider } = source(rows);
    await expect(readHostedLegacyTimers(provider, collection)).rejects.toThrow("source fence/schema/drain unavailable");
  });
  it("pages more than 64 timers without truncation and resumes after last INCLUDED key", async () => {
    const rows = Array.from({ length: 130 }, (_, index) => {
      const original = row();
      const record = JSON.parse(original.record_json);
      record.data.timer_id = `ab${String(index).padStart(3, "0")}`;
      record.id = `connect:${grant}:reminders:timer.${Buffer.from(record.data.timer_id).toString("hex")}`;
      return { ...metadata, ...original, runtime_id: record.id, record_json: JSON.stringify(record) };
    });
    const query = vi.fn().mockImplementation(async (_sql, params) => ({
      rows: rows.filter(row => params[2] === null || row.runtime_id > params[2]).slice(0, 65)
    }));
    const provider = { query } as unknown as DatabaseQueryable;
    let cursor: HostedLegacyTimerCursor | null = null;
    const seen: string[] = [];
    do {
      const page = await readHostedLegacyTimers(provider, collection, cursor);
      expect(page.timers.length).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(JSON.stringify({ timers: page.timers, fence: page.fence }))).toBeLessThanOrEqual(48 * 1024);
      if (page.nextCursor) expect(page.nextCursor.runtime_id).toBe(page.timers.at(-1)!.runtime_id);
      seen.push(...page.timers.map(timer => timer.runtime_id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(rows.map(row => row.runtime_id));
    expect(new Set(seen).size).toBe(130);
    expect(query.mock.calls[1][0]).toContain('(namespace COLLATE "C", id COLLATE "C") >');
  });
  it("rejects cross-namespace cursors and original fence drift between pages", async () => {
    const { provider } = source([{ ...metadata, ...row() }]);
    const page = await readHostedLegacyTimers(provider, collection);
    const cursor = { runtime_namespace: row().runtime_namespace, runtime_id: row().runtime_id, fence: page.fence };
    await expect(readHostedLegacyTimers(provider, collection, { ...cursor, runtime_namespace: "other" })).rejects.toThrow("cursor namespace");
    await expect(readHostedLegacyTimers(provider, collection, { ...cursor, fence: { ...page.fence, head: "1" } })).rejects.toThrow("original fence changed");
  });
  it("reserves native envelope bytes and refuses oversized full-record transport", async () => {
    const original = row();
    original.record_json = original.record_json.replace("original", "a".repeat(48 * 1024));
    const { provider } = source([{ ...metadata, ...original }]);
    await expect(readHostedLegacyTimers(provider, collection)).rejects.toThrow("oversized original raw record");
  });
});
