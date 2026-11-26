import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectDirect, directBackendOrigin, pairDirect } from "../src/direct.js";
import { openDirectMessages } from "../src/direct-messages.js";
import { decode, encode } from "../src/cbor.js";
import { clientFrame, syncStatus, type SyncStatus } from "../src/wire.js";
import { MemoryReplica } from "../src/testing/memory-replica.js";
import { MAX_FRAME, record } from "../src/transport/port.js";

import { bearer, bundle, firstSlot, hashes, pin, server, slotMs, token } from "./direct-calendar.fixture.js";

const code = "00123456";
const app = { name: "direct-fixture", version: "1" };
const text = (s: string) => new TextEncoder().encode(s);

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function transport() {
  const ready = gate<void>();
  const ended = gate<WebTransportCloseInfo>();
  const created = gate<void>();
  const writes: Uint8Array[] = [];
  const cancel = vi.fn();
  const abort = vi.fn();
  let input!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start(c) { input = c; }, cancel });
  const write = vi.fn((bytes: Uint8Array): void | Promise<void> => { writes.push(bytes); });
  const writable = new WritableStream<Uint8Array>({ write, abort });
  const create = vi.fn(async () => { await created.promise; return { readable, writable }; });
  const close = vi.fn();
  const opened = vi.fn();
  vi.stubGlobal("WebTransport", class {
    ready = ready.promise;
    closed = ended.promise;
    createBidirectionalStream = create;
    close = close;
    constructor(url: string, options: WebTransportOptions) { opened(url, { ...options }); }
  });
  return { ready, ended, created, writes, close, create, cancel, abort, opened, readable, writable, input, write,
    start() { ready.resolve(); created.resolve(); } };
}

const wss = vi.fn();
beforeEach(() => {
  wss.mockClear();
  vi.spyOn(Date, "now").mockReturnValue(firstSlot * slotMs);
  vi.stubGlobal("WebSocket", wss);
  vi.stubGlobal("location", { origin: "https://ui.example" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(wss).not.toHaveBeenCalled();
});

it.each(["127.0.0.1", "127.255.255.254", "10.255.255.255", "172.16.0.0", "172.31.255.255", "192.168.0.0", "100.64.0.0", "100.127.255.255"])("preserves the complete invitation for %s", host => {
  const descriptor = `https://${host}:65535#sha256=${pin}`;
  expect(directBackendOrigin(descriptor)).toBe(descriptor);
});

it.each([
  ...["172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0", "192.169.0.0", "169.254.0.1",
    "192.0.2.1", "0.0.0.0", "224.0.0.1", "1.1.1.1", "127.1", "2130706433", "0177.0.0.1", "0x7f.0.0.1",
    "127.0.0.1.", "127.0.0.256", "[::1]", "localhost", "private.example", "ui.example", "user@127.0.0.1",
  ].map(host => server.replace("127.0.0.1", host)),
  ...["", ":0", ":00080", ":65536", ":443/", ":443/x", ":443?code=123", ":443\\x"].map(end => server.replace(":443", end)),
  ...["", pin.toUpperCase(), pin.slice(1), pin + "a", pin + "&extra=1", pin + "#", pin + "\n"].map(hash => server.replace(pin, hash)),
  server.replace("https:", "http:"), server.replace("#sha256=", "#SHA256="),
])("rejects invalid or ambiguous invitations before either transport (%s)", async value => {
  const wt = transport();
  await expect(pairDirect({ server: value, code })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(connectDirect({ server: value, app, token })).rejects.toMatchObject({ code: "invalid_request" });
  expect(wt.opened).not.toHaveBeenCalled();
});

it("rejects the app's own origin even with an explicit default port and a pin", () => {
  vi.stubGlobal("location", { origin: "https://127.0.0.1" });
  expect(() => directBackendOrigin(server)).toThrow();
});

it("sends a single enveloped code and reads a fragmented token over the pinned session", async () => {
  const wt = transport();
  const paired = pairDirect({ server, code });
  expect(wt.opened.mock.calls).toEqual([["https://127.0.0.1/_mdbase/pair", {
    serverCertificateHashes: [{ algorithm: "sha-256", value: Uint8Array.from(Buffer.from(pin, "hex")) }],
  }]]);
  wt.start();
  await setImmediate();
  expect(wt.writes).toEqual([record(text(code))]);
  for (const byte of record(text(bundle))) wt.input.enqueue(Uint8Array.of(byte));
  wt.input.close();
  wt.ended.resolve({ closeCode: 0 });
  expect(await paired).toBe(token);
  expect(wt.create).toHaveBeenCalledTimes(1);
  expect(wt.close).toHaveBeenCalledTimes(1);
  expect(wt.abort).toHaveBeenCalledTimes(1);
  expect(wt.readable.locked || wt.writable.locked).toBe(false);
});

it("hands the existing replica hello and coalesced frames to the SDK session, including live revocation", async () => {
  const wt = transport();
  const connecting = connectDirect({ server, token, app });
  wt.start();
  await setImmediate();
  expect(wt.opened.mock.calls).toEqual([["https://127.0.0.1/_mdbase/replica", {
    serverCertificateHashes: hashes.slice(0, 2).map(hash => ({ algorithm: "sha-256", value: Uint8Array.from(Buffer.from(hash, "hex")) })),
  }]]);
  expect(wt.writes).toHaveLength(2);
  expect(wt.writes[0]).toEqual(record(text(bearer)));
  const hello = decode(wt.writes[1]!.subarray(8));
  expect(wt.writes[1]).toEqual(record(record(encode(hello))));
  expect(clientFrame.dec(hello)).toMatchObject({ kind: "request", method: "hello", id: 0 });
  const replica = new MemoryReplica();
  const peer = await replica.connector().open(hello);
  const response = record(record(encode(peer.helloResponse)));
  const status: SyncStatus = { mode: "local_only", confirmedThrough: 7, headKnown: 7, pending: 0, holds: 0,
    unresolved: 0, connection: "online", incidents: [] };
  const push = record(record(encode(clientFrame.enc({ kind: "push", type: "status",
    payload: syncStatus.enc(status) }))));
  wt.input.enqueue(Uint8Array.from([...response, ...push]));
  const client = await connecting;
  expect(client.collection).toBe(replica.collection);
  await setImmediate();
  expect(client.status.confirmedThrough).toBe(7);
  const pending = client.resources.get("x.md");
  const denied = expect(pending).rejects.toMatchObject({ code: "unauthenticated" });
  await setImmediate();
  const request = clientFrame.dec(decode(wt.writes.at(-1)!.subarray(8)));
  expect(request).toMatchObject({ kind: "request", method: "get_resource" });
  wt.input.close(); // FIN can beat the session close capsule.
  await setImmediate();
  wt.ended.resolve({ closeCode: 1008 });
  await denied;
  expect(client.linkProblem?.code).toBe("unauthenticated");
  expect(wt.create).toHaveBeenCalledTimes(1);
  expect(wt.close).toHaveBeenCalledTimes(1);
  peer.port.close();
  client.close();
});

type Operation = "pair" | "replica";
const operations: Operation[] = ["pair", "replica"];
function start(operation: Operation, signal?: AbortSignal) {
  return operation === "pair" ? pairDirect({ server, code, signal }) : connectDirect({ server, token, app, signal });
}

it.each(operations)("fails closed on missing, pin-unaware, or pin-rejecting WebTransport for %s", async operation => {
  vi.stubGlobal("WebTransport", undefined);
  await expect(start(operation)).rejects.toMatchObject({ code: "unavailable", reason: "browser_unsupported" });
  const close = vi.fn(), create = vi.fn();
  vi.stubGlobal("WebTransport", class {
    ready = Promise.resolve();
    closed = new Promise(() => {});
    close = close;
    createBidirectionalStream = create;
  });
  await expect(start(operation)).rejects.toMatchObject({ code: "unavailable", reason: "browser_unsupported" });
  expect(close).toHaveBeenCalledOnce();
  expect(create).not.toHaveBeenCalled();
  const wt = transport();
  const failed = expect(start(operation)).rejects.toMatchObject({ code: "unavailable", ...(operation === "pair" ? { reason: "code_not_sent" } : {}) });
  wt.ready.reject(new Error("certificate mismatch"));
  wt.ended.reject(new Error("connection failed"));
  await failed;
  expect(wt.create).not.toHaveBeenCalled();
  expect(wt.writes).toEqual([]);
});

it.each(operations)("only an explicit session denial means unauthenticated for %s", async operation => {
  const wt = transport();
  const failed = expect(start(operation)).rejects.toMatchObject({ code: "unauthenticated" });
  wt.start();
  await setImmediate();
  wt.input.error(new Error("stream reset"));
  await setImmediate();
  wt.ended.resolve({ closeCode: 1008 });
  await failed;
  expect(wt.close).toHaveBeenCalledOnce();
});

it.each(operations)("cancels %s before transport creation or while a stream opens", async operation => {
  const wt = transport();
  const signal = new AbortController();
  signal.abort();
  await expect(start(operation, signal.signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(wt.opened).not.toHaveBeenCalled();
  const active = new AbortController();
  const failed = expect(start(operation, active.signal)).rejects.toMatchObject({ code: "cancelled" });
  wt.ready.resolve();
  await setImmediate();
  expect(wt.create).toHaveBeenCalledOnce();
  active.abort();
  await failed;
  wt.created.resolve();
  await setImmediate();
  expect(wt.writes).toEqual([]);
  expect(wt.cancel).toHaveBeenCalledOnce();
  expect(wt.abort).toHaveBeenCalledOnce();
  expect(wt.close).toHaveBeenCalledOnce();
});

it.each(operations)("times out %s while connecting or waiting for a reply, and closes late work", async operation => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (const ready of [false, true]) {
    const wt = transport();
    let reason: string | undefined, settled = false;
    const failed = start(operation).then(() => { throw new Error("connected"); }, error => {
      settled = true;
      expect(error).toMatchObject({ code: "unavailable" });
      reason = error.reason;
    });
    if (ready) wt.start();
    await setImmediate();
    const sent = wt.writes.length;
    expect(sent).toBe(ready ? (operation === "pair" ? 1 : 2) : 0);
    // A browser permission prompt can hold the connection open far longer than a reply takes.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(ready);
    if (!ready) await vi.advanceTimersByTimeAsync(50_000);
    await failed;
    // Only a pairing code that never left the browser is known to be unused.
    expect(reason).toBe(operation === "pair" && !ready ? "code_not_sent" : undefined);
    wt.start();
    await setImmediate();
    expect(wt.writes).toHaveLength(sent);
    expect(wt.close).toHaveBeenCalledOnce();
    expect(wt.create).toHaveBeenCalledTimes(ready ? 1 : 0);
    expect(wt.readable.locked || wt.writable.locked).toBe(false);
  }
});

it.each([
  ["pair", [0, 0, 0, 0]], ["pair", [255, 255, 255, 255]], ["pair", [...record(new Uint8Array(64).fill(255))]],
  ["pair", [0, 0]], ["pair", [0, 0, 0, 64, 97]], ["replica", [255, 255, 255, 255]], ["replica", [0, 0, 0, 4]],
  ["replica", [0, 0, 0, 5, 0, 0, 0, 3, 1]],
] satisfies [Operation, number[]][])("rejects malformed %s envelopes", async (operation, bytes) => {
  const wt = transport();
  const failed = expect(start(operation)).rejects.toMatchObject({ code: "invalid_request" });
  wt.start();
  wt.input.enqueue(Uint8Array.from(bytes));
  wt.input.close();
  await failed;
  expect(wt.close).toHaveBeenCalledOnce();
});

it("refuses oversized replica messages from their header alone", async () => {
  const wt = transport();
  const failed = expect(start("replica")).rejects.toMatchObject({ code: "invalid_request" });
  wt.start();
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, MAX_FRAME + 5);
  wt.input.enqueue(header);
  await failed;
  expect(wt.close).toHaveBeenCalledOnce();
});

it.each(["message count", "byte count"])("bounds queued writes by %s and releases the stream on overflow", async limit => {
  const wt = transport();
  const drain = gate<void>();
  wt.write.mockImplementation(() => drain.promise);
  const failed = vi.fn(() => messages.close());
  const messages = openDirectMessages(server, { operation: "replica", hashes: [pin] }, { ready() {}, message() {}, failed });
  wt.start();
  await setImmediate();

  const bytes = new Uint8Array(limit === "message count" ? 5 : MAX_FRAME + 4);
  const accepted = limit === "message count" ? 16 : 1;
  for (let i = 0; i < accepted; i++) messages.send(bytes);
  await setImmediate();
  expect(wt.write).toHaveBeenCalledOnce();
  expect(() => messages.send(bytes)).toThrow("Direct send queue is full");
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: "too_large" }));
  drain.resolve();
  await setImmediate();
  expect(wt.write).toHaveBeenCalledOnce();
  expect(wt.abort).toHaveBeenCalledOnce();
  expect(wt.close).toHaveBeenCalledOnce();
  expect(wt.readable.locked || wt.writable.locked).toBe(false);
});

it.each(["FIN", "write error"])("closes a broken stream after %s without a session close code", async reason => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const wt = transport();
  if (reason === "write error") wt.write.mockRejectedValue(new Error("peer reset"));
  const failed = expect(start("replica")).rejects.toMatchObject({ code: "unavailable" });
  wt.start();
  await setImmediate();
  if (reason === "FIN") wt.input.close();
  await setImmediate();
  await vi.advanceTimersByTimeAsync(1_000);
  await failed;
  expect(wt.close).toHaveBeenCalledOnce();
  expect(wt.readable.locked || wt.writable.locked).toBe(false);
});

it.each([
  ["raw bearer", bearer], ["wrong version", bundle.replace("WTP1", "WTP2")],
  ["missing pin", bundle.slice(0, -65)], ["extra pin", bundle + "." + pin],
  ["duplicate pin", bundle.replace(hashes[2]!, hashes[1]!)],
  ["uppercase pin", bundle.replace(pin, pin.toUpperCase())],
  ["wrong enrollment pin", bundle.replace(pin, "bc".repeat(32))],
  ["invitation pin in the second slot", ["WTP1", bearer, firstSlot, hashes[1], pin, ...hashes.slice(2)].join(".")],
  ["malformed bearer", bundle.replace(bearer, bearer.toUpperCase())],
  ["non-ASCII", bundle.replace(pin, "é" + pin.slice(1))],
  ...["-1", "01700", "1.7e3", "+1700", "1700\n", "9007199254740992"].map(slot =>
    ["invalid first slot", bundle.replace(".1700.", `.${slot}.`)]),
])("refuses %s in a pinned pairing response", async (_name, reply) => {
  const wt = transport();
  const failed = expect(pairDirect({ server, code })).rejects.toMatchObject({ code: "invalid_request" });
  wt.start();
  wt.input.enqueue(record(text(reply!)));
  wt.input.close();
  await failed;
  expect(wt.writes).toEqual([record(text(code))]);
});

it.each(["replay", "partial header", "partial payload"])("rejects a valid pair reply followed by %s", async suffix => {
  const wt = transport();
  const failed = expect(pairDirect({ server, code })).rejects.toMatchObject({ code: "invalid_request" });
  const frame = record(text(bundle));
  wt.start();
  wt.input.enqueue(frame);
  await setImmediate();
  wt.input.enqueue(suffix === "replay" ? frame : frame.subarray(0, suffix === "partial header" ? 1 : 9));
  wt.input.close();
  await failed;
  expect(wt.close).toHaveBeenCalledOnce();
});

it.each([
  [server.replace("127.0.0.1", "10.0.0.1"), token],
  [server.replace(":443", ":8443"), token],
  [server.replace(pin, hashes[1]!), token],
  [server, bearer], [server, bundle], [server, JSON.stringify([server, bundle.replace(pin, hashes[2]!)])],
  ["https://127.0.0.1", token], ["https://127.0.0.1", bundle],
])("rejects credential or enrollment substitution before transport", async (target, credential) => {
  const wt = transport();
  await expect(connectDirect({ server: target, app, token: credential })).rejects.toMatchObject({ code: "unauthenticated" });
  expect(wt.opened).not.toHaveBeenCalled();
});

it.each([
  [0, [0, 1]], [slotMs - 1, [0, 1]], [slotMs, [0, 1, 2]],
  [17 * slotMs, [16, 17, 18]], [32 * slotMs - 1, [30, 31]],
] as const)("uses only authorized neighbor pins at offset %i", async (offset, indices) => {
  vi.mocked(Date.now).mockReturnValue(firstSlot * slotMs + offset);
  const wt = transport();
  const failed = expect(start("replica")).rejects.toMatchObject({ code: "unavailable" });
  wt.start();
  await setImmediate();
  expect(wt.opened.mock.calls).toEqual([["https://127.0.0.1/_mdbase/replica", {
    serverCertificateHashes: indices.map(i => ({ algorithm: "sha-256", value: Uint8Array.from(Buffer.from(hashes[i]!, "hex")) })),
  }]]);
  expect(wt.writes[0]).toEqual(record(text(bearer)));
  expect(wt.writes).toHaveLength(2);
  wt.ended.reject(new Error("disconnected"));
  await failed;
});

it.each([-1, 32 * slotMs])("refuses clocks outside the calendar before opening or sending at offset %i", async offset => {
  const wt = transport();
  const failed = expect(start("replica")).rejects.toMatchObject({ code: "unavailable" });
  vi.mocked(Date.now).mockReturnValue(firstSlot * slotMs + offset);
  wt.start();
  await failed;
  expect(wt.writes).toEqual([]);
  await expect(start("replica")).rejects.toMatchObject({ code: "unavailable" });
  expect(wt.opened).toHaveBeenCalledOnce();
});

it("reuses the grant returned at enrollment for a later certificate", async () => {
  const enrollment = transport();
  const pairing = pairDirect({ server, code });
  enrollment.start();
  enrollment.input.enqueue(record(text(bundle)));
  enrollment.input.close();
  const grant = await pairing;
  vi.mocked(Date.now).mockReturnValue((firstSlot + 31) * slotMs);
  const replica = transport();
  const connecting = connectDirect({ server, app, token: grant });
  const offered = replica.opened.mock.calls[0]![1].serverCertificateHashes;
  expect(offered.map((hash: WebTransportHash) => Buffer.from(hash.value as Uint8Array).toString("hex")))
    .toEqual(hashes.slice(30));
  replica.start();
  await setImmediate();
  expect(replica.writes[0]).toEqual(record(text(bearer)));
  const peer = await new MemoryReplica().connector().open(decode(replica.writes[1]!.subarray(8)));
  replica.input.enqueue(record(record(encode(peer.helloResponse))));
  const client = await connecting;
  for (const frame of replica.writes.slice(1)) {
    expect(clientFrame.dec(decode(frame.subarray(8))).kind).toBe("request");
    const bytes = Buffer.from(frame);
    expect([bearer, ...hashes].some(secret => bytes.includes(secret))).toBe(false);
  }
  client.close();
  peer.port.close();
});

it.each([0, Number.MAX_SAFE_INTEGER])("accepts canonical first slot %i", async slot => {
  const wt = transport();
  const paired = pairDirect({ server, code });
  wt.start();
  const response = bundle.replace(".1700.", `.${slot}.`);
  wt.input.enqueue(record(text(response)));
  wt.input.close();
  expect(await paired).toBe(JSON.stringify([server, response]));
});

it("refuses an oversized pairing frame before reading its payload", async () => {
  const wt = transport();
  const failed = expect(start("pair")).rejects.toMatchObject({ code: "invalid_request" });
  wt.start();
  const header = new Uint8Array(4);
  const longest = bundle.replace(".1700.", `.${Number.MAX_SAFE_INTEGER}.`);
  new DataView(header.buffer).setUint32(0, longest.length + 1);
  wt.input.enqueue(header);
  await failed;
  expect(wt.close).toHaveBeenCalledOnce();
});
