import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decode, encode, fromHex, type CborValue } from "../src/cbor.js";
import { decodeAppBasesResult, encodeAppBasesRequest, type AppBasesRequest } from "../src/app-host/bases-wire.js";
import { connect } from "../src/client.js";
import { MemoryReplica } from "../src/testing/index.js";

const legacy = JSON.parse(readFileSync(new URL("./fixtures/native-bases-app-codec.json", import.meta.url), "utf8")) as {
  request_hex: string;
  success_hex: string;
};
const baseRequest: AppBasesRequest = {
  record: "11111111-1111-1111-1111-111111111111",
  sourceRevision: `sha256:${"22".repeat(32)}`,
  ordinal: 3,
  hints: new Map([["due", "date"], ["scheduled", "date"]]),
  captureTimezone: "UTC",
};

describe("app Bases rowProperties wire codec and compatibility", () => {
  it("encodes optional key 7 alongside or without window key 6 and preserves legacy bytes when absent", () => {
    expect(encodeAppBasesRequest(baseRequest)).toEqual(fromHex(legacy.request_hex));
    const withoutWindow = decode(encodeAppBasesRequest({ ...baseRequest, rowProperties: ["title", "status"] })) as Map<number, CborValue>;
    expect([...withoutWindow.keys()]).toEqual([0, 1, 2, 3, 4, 5, 7]);
    expect(withoutWindow.get(7)).toEqual(["title", "status"]);
    const withWindow = decode(encodeAppBasesRequest({ ...baseRequest, window: { offset: 0, limit: 200 }, rowProperties: ["due"] })) as Map<number, CborValue>;
    expect([...withWindow.keys()]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(withWindow.get(7)).toEqual(["due"]);
    const empty = decode(encodeAppBasesRequest({ ...baseRequest, rowProperties: [] })) as Map<number, CborValue>;
    expect(empty.get(7)).toEqual([]);
  });

  it("rejects invalid rowProperties inputs before encoding", () => {
    for (const rowProperties of [
      [""],
      ["dup", "dup"],
      ["a".repeat(257)],
      Array.from({ length: 129 }, (_, i) => `f${i}`),
      Array.from({ length: 70 }, (_, i) => `${i}_${"x".repeat(240)}`),
    ]) {
      expect(() => encodeAppBasesRequest({ ...baseRequest, rowProperties })).toThrow();
    }
  });

  it("decodes key 10 row types and properties and enforces exact request/response agreement", () => {
    const wire = decode(fromHex(legacy.success_hex)) as Map<number, CborValue>;
    wire.set(10, [[["task"], new Map<string, CborValue>([["title", "Ship 4a"], ["priority", 2]])]]);
    const bytes = encode(wire);
    const decoded = decodeAppBasesResult(bytes, null, ["title", "priority", "due"]);
    expect(decoded.kind).toBe("success");
    if (decoded.kind !== "success") return;
    expect(decoded.rows[0]!.types).toEqual(["task"]);
    expect(decoded.rows[0]!.properties).toEqual({ title: "Ship 4a", priority: 2 });
    // Key 10 must be rejected when not requested, and missing key 10 rejected when requested.
    expect(() => decodeAppBasesResult(bytes)).toThrow();
    expect(() => decodeAppBasesResult(bytes, null, null)).toThrow();
    expect(() => decodeAppBasesResult(fromHex(legacy.success_hex), null, ["title"])).toThrow();
    // Unexpected unrequested property key in response is refused.
    expect(() => decodeAppBasesResult(bytes, null, ["title"])).toThrow();
    // Mismatched row count is refused.
    wire.set(10, []);
    expect(() => decodeAppBasesResult(encode(wire), null, ["title"])).toThrow();
  });

  it("returns projected row types and properties over executeAppBases and refuses old replicas", async () => {
    const replica = new MemoryReplica();
    replica.seed({ path: "tasks/a.md", types: ["task"], frontmatter: { title: "First", status: "open", noise: "huge" } });
    replica.seed({ path: "tasks/b.md", types: ["task", "urgent"], frontmatter: { title: "Second", status: "done", due: "2026-12-01" } });
    const view = replica.seedBaseView({ path: "views/tasks.base", name: "All", columns: ["note.status"], types: ["task"] });
    const client = await connect({ connector: replica.connector(), app: { name: "test", version: "0" }, reconnect: false });
    try {
      const result = await client.executeAppBases({
        record: view.record,
        sourceRevision: view.sourceRevision,
        ordinal: 0,
        hints: new Map(),
        captureTimezone: "UTC",
        window: { offset: 0, limit: 10 },
        rowProperties: ["title", "status", "due"],
      });
      expect(result.kind).toBe("success");
      if (result.kind !== "success") return;
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]!.types).toEqual(["task"]);
      expect(result.rows[0]!.properties).toEqual({ title: "First", status: "open" });
      expect(result.rows[1]!.types).toEqual(["task", "urgent"]);
      expect(result.rows[1]!.properties).toEqual({ title: "Second", status: "done", due: "2026-12-01" });
    } finally {
      client.close();
    }

    const oldReplica = new MemoryReplica({ features: [] });
    const oldView = oldReplica.seedBaseView({ path: "views/tasks.base", name: "All", columns: ["note.status"], types: ["task"] });
    const oldClient = await connect({ connector: oldReplica.connector(), app: { name: "test", version: "0" }, reconnect: false });
    try {
      await expect(oldClient.executeAppBases({
        record: oldView.record,
        sourceRevision: oldView.sourceRevision,
        ordinal: 0,
        hints: new Map(),
        captureTimezone: "UTC",
        rowProperties: ["title"],
      })).rejects.toMatchObject({ code: "upgrade_required", reason: "bases_row_properties_unsupported" });
      // Without rowProperties, old replicas continue to succeed unchanged.
      const ok = await oldClient.executeAppBases({
        record: oldView.record,
        sourceRevision: oldView.sourceRevision,
        ordinal: 0,
        hints: new Map(),
        captureTimezone: "UTC",
      });
      expect(ok.kind).toBe("success");
    } finally {
      oldClient.close();
    }
  });
});
