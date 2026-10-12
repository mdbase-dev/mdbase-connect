import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../canonical-json.js";
import { importInstant, validateTimerImport } from "./import-original.js";

function fixture(status: "scheduled" | "fired" = "scheduled") {
  const timer = {
    grant_id: "00000000-0000-4000-8000-000000000001", namespace: "notifications", id: "reminder-a",
    criterion_id: "task.reminder", generation: "7", status,
    fire_at: "2030-01-01T00:00:00.123456789Z", created_at: "2020-01-01T00:00:00.000000001Z",
    updated_at: "2020-01-02T00:00:00.000000000Z", fired_at: status === "fired" ? "2030-01-01T00:00:01.999999999Z" : null,
    runtime_namespace: "connect-hosted:00000000-0000-4000-8000-000000000002:notifications",
    runtime_id: "scoped-reminder-a", data: { task_id: "task-a" }
  };
  const record = {
    id: timer.runtime_id, generation: 7, status, fire_at: timer.fire_at,
    created_at: timer.created_at, updated_at: timer.updated_at, fired_at: timer.fired_at,
    event_contract: { id: "io.mdbase.timer.fired", version: "1.0.0", digest: "sha256:example" },
    event_source: { application: "connect", implementation: "notifications", version: "1.0.0" },
    source_uri: "urn:test:timer", subject: null,
    data: { grant_id: timer.grant_id, criterion_id: timer.criterion_id, namespace: timer.namespace, timer_id: timer.id, data: timer.data }
  };
  return { timer: { ...timer, record_json: JSON.stringify(record) }, record };
}

describe("strict original timer target validation (not source/flip authority)", () => {
  it("floors pending due time, retaining exact lost digits without copying content", () => {
    const { timer, record } = fixture();
    const result = validateTimerImport(timer);
    expect(importInstant(timer.fire_at)).toBe("2030-01-01T00:00:00.123456Z");
    expect(result.origin.exact_timestamps).toEqual({ fire_at: timer.fire_at, created_at: timer.created_at });
    expect(result.origin.record_sha256).toBe(createHash("sha256").update(canonicalJson(record)).digest("hex"));
    expect(result.origin).not.toHaveProperty("data");
    expect(result.origin).not.toHaveProperty("record_json");
  });
  it("stores only original JCS digests for source/subject and structured headers", () => {
    const { timer, record: originalRecord } = fixture();
    const record = { ...originalRecord, subject: "private task name", source_uri: "mdbase://private/record/path",
      event_source: { ...originalRecord.event_source, instance_id: "private header identity" } };
    const { origin } = validateTimerImport({ ...timer, record_json: JSON.stringify(record) });
    const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
    expect(origin.subject_sha256).toBe(hash(record.subject));
    expect(origin.source_uri_sha256).toBe(hash(record.source_uri));
    expect(origin.event_source).toBe(hash(record.event_source));
    expect(origin.event_contract).toBe(hash(record.event_contract));
    expect(origin.record_sha256).toBe(hash(record));
    expect(origin).not.toHaveProperty("subject");
    expect(origin).not.toHaveProperty("source_uri");
    expect(JSON.stringify(origin)).not.toContain("private");
  });
  it("hashes a null original subject as the JCS scalar null", () => {
    expect(validateTimerImport(fixture().timer).origin.subject_sha256).toBe(createHash("sha256").update("null").digest("hex"));
  });
  it.each(["x".repeat(2048), "🧠".repeat(512)])("refuses oversized metadata without dropping fields", (runtime_namespace) => {
    expect(() => validateTimerImport({ ...fixture().timer, runtime_namespace })).toThrow(expect.objectContaining({ statusCode: 409, code: "timer_import_invalid" }));
  });
  it.each(["invalid\u0000namespace", "invalid\ud800namespace"])("refuses unrepresentable DTO metadata", (runtime_namespace) => {
    expect(() => validateTimerImport({ ...fixture().timer, runtime_namespace })).toThrow(expect.objectContaining({ statusCode: 409, code: "timer_import_invalid" }));
  });
  it("refuses NUL in original content instead of allowing a later JSONB failure", () => {
    const { timer, record } = fixture();
    expect(() => validateTimerImport({ ...timer, record_json: JSON.stringify({ ...record, subject: String.fromCharCode(0) }) })).toThrow();
  });
  it("preserves original fired nanoseconds and generation without resetting state", () => {
    const { timer } = fixture("fired");
    const result = validateTimerImport(timer);
    expect(result.timer.generation).toBe("7");
    expect(result.timer.status).toBe("fired");
    expect(importInstant(timer.fired_at!)).toBe("2030-01-01T00:00:01.999999Z");
    expect(result.origin.exact_timestamps?.fired_at).toBe(timer.fired_at);
  });
  it("does not store exact timestamp extensions when no nonzero digits are lost", () => {
    const { timer, record } = fixture();
    record.fire_at = timer.fire_at = "2030-01-01T00:00:00.123456000Z";
    record.created_at = timer.created_at = "2020-01-01T00:00:00Z";
    expect(validateTimerImport({ ...timer, record_json: JSON.stringify(record) }).origin).not.toHaveProperty("exact_timestamps");
  });
  it.each(["2030-02-30T00:00:00Z", "2030-01-01T00:00:60Z", "2030-01-01T00:00:00+01:00", "2030-01-01T00:00:00.1234567891Z", "0000-01-01T00:00:00Z"])("refuses unrepresentable instant %s", (instant) => {
    expect(() => importInstant(instant)).toThrow();
  });
  it("refuses generation/status/wrapper/due drift and incomplete projections", () => {
    const { timer } = fixture();
    for (const changed of [{ generation: "8" }, { status: "firing" }, { id: "foreign" }, { fire_at: "2030-01-01T00:00:00.123456788Z" }, { record_json: undefined }]) {
      expect(() => validateTimerImport({ ...timer, ...changed })).toThrow();
    }
  });
  it("refuses duplicate keys, unsafe integers and invalid Unicode before hashing", () => {
    const { timer } = fixture();
    for (const record_json of [timer.record_json.replace('"generation":7', '"generation":7,"generation":7'), timer.record_json.replace('"generation":7', '"generation":9007199254740993'), timer.record_json.replace('"subject":null', '"subject":"\\ud800"')]) {
      expect(() => validateTimerImport({ ...timer, record_json })).toThrow();
    }
  });
});
