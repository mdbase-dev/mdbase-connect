import { describe, expect, it } from "vitest";
import type { CborValue } from "../src/cbor.js";
import { decode, encode } from "../src/cbor.js";
import { connect } from "../src/client.js";
import { MemoryReplica } from "../src/testing/index.js";
import type { Connector, FramePort } from "../src/transport/port.js";
import { clientFrame, listResourcesResult, type ListResourcesResult, type Problem, type ResourceView } from "../src/wire.js";

const source: ResourceView = {
  path: "_types/task.md", revision: `sha256:${"08".repeat(32)}`, size: 3,
  state: "confirmed", text: "abc",
};

// Synthetic wire capture over one ordinary SDK session, not a native inventory
// or cursor-currentness qualification. Native producer vectors are separate.
async function capturedPages(replies: (ListResourcesResult | Problem)[]) {
  const original = new MemoryReplica().connector();
  const requests: Map<number, CborValue>[] = [];
  let opens = 0;
  const connector: Connector = {
    description: "resource-page-wire-capture",
    async open(hello, signal) {
      opens++;
      const opened = await original.open(hello, signal);
      const port: FramePort = {
        onframe: null, onclose: null,
        send(value) {
          const frame = clientFrame.dec(value);
          if (frame.kind !== "request" || frame.method !== "list_resources") {
            opened.port.send(value);
            return;
          }
          requests.push(frame.params as Map<number, CborValue>);
          const reply = replies[requests.length - 1];
          if (!reply) throw Error("Unexpected extra inventory request");
          const response = "code" in reply
            ? clientFrame.enc({ kind: "response", id: frame.id, problem: reply })
            : clientFrame.enc({ kind: "response", id: frame.id, result: listResourcesResult.enc(reply) });
          queueMicrotask(() => port.onframe?.(response));
        },
        close() { opened.port.close(); },
      };
      opened.port.onframe = (value) => port.onframe?.(value);
      opened.port.onclose = (error) => port.onclose?.(error);
      return { ...opened, port };
    },
  };
  const client = await connect({ connector, app: { name: "resource-pages-test", version: "0" }, reconnect: false });
  return { client, requests, opens: () => opens };
}

describe("resource inventory page wire shape", () => {
  it("retains byte-identical terminal two-key results and omitted request options", async () => {
    const raw = new Map<number, CborValue>([[0, []], [1, true]]);
    expect(encode(listResourcesResult.enc(listResourcesResult.dec(raw)))).toEqual(encode(raw));
    const f = await capturedPages([{ resources: [], complete: true }]);
    try {
      expect(await f.client.resources.list()).toEqual({ resources: [], complete: true });
      expect([...f.requests[0]!.keys()]).toEqual([]);
      expect(f.opens()).toBe(1);
    } finally { f.client.close(); }
  });

  it("carries the original opaque cursor and unchanged selection on one held client", async () => {
    const cursor = "opaque-original-inventory";
    const f = await capturedPages([
      { resources: [source], complete: false, cursor },
      { resources: [{ ...source, path: "_types/second.md" }], complete: true },
    ]);
    try {
      const first = await f.client.resources.list({ folder: "_types", text: true, limit: 1 });
      expect(first.complete).toBe(false);
      expect(first.cursor).toBe(cursor);
      const last = await f.client.resources.list({ folder: "_types", text: true, limit: 1, cursor: first.cursor });
      expect(last).toEqual({ resources: [{ ...source, path: "_types/second.md" }], complete: true });
      expect([...f.requests[0]!.entries()]).toEqual([[0, "_types"], [1, true], [3, 1]]);
      expect([...f.requests[1]!.entries()]).toEqual([[0, "_types"], [1, true], [2, cursor], [3, 1]]);
      expect(f.opens()).toBe(1);
    } finally { f.client.close(); }
  });

  it("does not infer complete or confirmation from a cursor or source text", () => {
    const value = listResourcesResult.enc({ resources: [{ ...source, state: "pending" }], complete: false, cursor: "opaque" });
    expect(listResourcesResult.dec(value)).toEqual({ resources: [{ ...source, state: "pending" }], complete: false, cursor: "opaque" });
  });

  it("rejects non-string continuation arms without changing existing resource decoding", () => {
    for (const cursor of [null, 1, false, new Uint8Array([1])]) {
      const value = new Map<number, CborValue>([[0, []], [1, false], [2, cursor]]);
      expect(() => listResourcesResult.dec(value)).toThrow();
    }
    const value = listResourcesResult.enc({ resources: [source], complete: false, cursor: "opaque" }) as Map<number, CborValue>;
    const row = (value.get(0) as CborValue[])[0] as Map<number, CborValue>;
    row.set(3, 2);
    expect(() => listResourcesResult.dec(value)).toThrow();
  });

  it.each(["invalid_resource_cursor", "cursor_stale", "cursor_expired"])("surfaces %s without restarting or reopening", async (reason) => {
    const f = await capturedPages([{ code: "invalid_request", recovery: "fix_request", message: "Inventory continuation refused", reason }]);
    try {
      await expect(f.client.resources.list({ text: true, cursor: "original" })).rejects.toMatchObject({ code: "invalid_request", reason });
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]!.get(2)).toBe("original");
      expect(f.opens()).toBe(1);
    } finally { f.client.close(); }
  });

  it("surfaces pending inventory refusal rather than complete-empty fallback", async () => {
    const f = await capturedPages([{ code: "unavailable", recovery: "retry", message: "Resource inventory pending", reason: "resource_inventory_pending" }]);
    try {
      await expect(f.client.resources.list({ text: true })).rejects.toMatchObject({ code: "unavailable", reason: "resource_inventory_pending" });
      expect(f.requests).toHaveLength(1);
      expect(f.opens()).toBe(1);
    } finally { f.client.close(); }
  });

  it("roundtrips the optional cursor without changing resource row bytes", () => {
    const original = listResourcesResult.enc({ resources: [source], complete: false, cursor: "opaque" });
    expect(encode(listResourcesResult.enc(listResourcesResult.dec(decode(encode(original)))))).toEqual(encode(original));
  });
});
