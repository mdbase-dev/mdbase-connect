import { afterEach, expect, it, vi } from "vitest";
import { connectDirect, pairDirect } from "../src/direct.js";
import { decode } from "../src/cbor.js";
import { clientFrame } from "../src/wire.js";

import { bundle } from "./direct-calendar.fixture.js";

const app = { name: "fixture", version: "1" };
const token = "a".repeat(64);
const ui = "https://ui.invalid";
const server = "https://backend.invalid:8443";
afterEach(() => vi.unstubAllGlobals());

it.each(["http://127.0.0.1", "wss://backend.invalid", "file:///", ui, "https://@backend.invalid", "https://backend.invalid?key", "https://backend.invalid/#", "https://backend.invalid/path", "https://u:p@backend.invalid", "https://backend.invalid\\path", "https://backend.invalid\n"])("sends nothing to unsafe server %s", async server => {
  vi.stubGlobal("location", { origin: ui });
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", socket);
  await expect(connectDirect({ app, token, server })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(pairDirect({ server, code: "00000017" })).rejects.toMatchObject({ code: "invalid_request" });
  expect(socket).not.toHaveBeenCalled();
});

it("refuses a malformed key before opening any socket", async () => {
  vi.stubGlobal("location", { origin: "https://fixture.invalid" });
  const socket = vi.fn();
  vi.stubGlobal("WebSocket", socket);
  await expect(connectDirect({ app, server, token: `${token.slice(1)}\n` })).rejects.toMatchObject({ code: "unauthenticated" });
  await expect(pairDirect({ server, code: "abc45678" })).rejects.toMatchObject({ code: "invalid_request" });
  vi.stubGlobal("location", { origin: "http://ui.invalid" });
  await expect(pairDirect({ server, code: "00000017" })).rejects.toMatchObject({ code: "invalid_request" });
  expect(socket).not.toHaveBeenCalled();
});

it("uses only the selected backend and fails closed on an invalid hello", async () => {
  const sent: (string | Uint8Array)[] = [];
  const closed = vi.fn();
  let address = "";
  vi.stubGlobal("location", { origin: ui });
  vi.stubGlobal("WebSocket", class {
    onopen?: () => void;
    onmessage?: (event: { data: ArrayBuffer }) => void;
    close = closed;
    constructor(url: URL) {
      address = url.href;
      queueMicrotask(() => this.onopen!());
    }
    send(value: string | Uint8Array) {
      sent.push(value);
      if (typeof value !== "string") queueMicrotask(() => this.onmessage!({ data: new ArrayBuffer(0) }));
    }
  });
  await expect(connectDirect({ app, token, server })).rejects.toMatchObject({ code: "invalid_request" });
  expect(address).toBe("wss://backend.invalid:8443/_mdbase/replica");
  expect(sent).toHaveLength(2);
  expect(sent[0] === token).toBe(true);
  const hello = sent[1] as Uint8Array;
  expect(new DataView(hello.buffer, hello.byteOffset).getUint32(0)).toBe(hello.length - 4);
  expect(clientFrame.dec(decode(hello.subarray(4)))).toMatchObject({ kind: "request", method: "hello", id: 0 });
  expect(closed).toHaveBeenCalledTimes(1);
});

it.each(["success", "denied", "offline", "malformed", "calendar"])("pairs once and distinguishes %s", async outcome => {
  const sent: string[] = [];
  const closed = vi.fn();
  vi.stubGlobal("location", { origin: ui });
  vi.stubGlobal("WebSocket", class {
    onopen?: () => void;
    onclose?: (event: { code: number }) => void;
    onmessage?: (event: { data: string }) => void;
    close = closed;
    constructor(url: URL) {
      expect(url.href).toBe("wss://backend.invalid:8443/_mdbase/pair");
      queueMicrotask(() => this.onopen!());
    }
    send(value: string) {
      sent.push(value);
      queueMicrotask(() => {
        if (outcome === "offline" || outcome === "denied") this.onclose!({ code: outcome === "offline" ? 1006 : 1008 });
        else this.onmessage!({ data: outcome === "success" ? token : outcome === "calendar" ? bundle : "bad" });
      });
    }
  });
  const paired = pairDirect({ server, code: "00000017" });
  if (outcome === "success") await expect(paired).resolves.toBe(token);
  else await expect(paired).rejects.toMatchObject({ code: { offline: "unavailable", denied: "unauthenticated", malformed: "invalid_request", calendar: "invalid_request" }[outcome] });
  expect(sent).toEqual(["00000017"]);
  expect(closed).toHaveBeenCalledTimes(1);
});
