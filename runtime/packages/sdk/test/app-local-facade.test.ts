import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appLocalConnector, attachAppLocalFacade, type AppLocalScope } from "../src/app-host/local-facade.js";
import type { CborValue } from "../src/cbor.js";
import type { FramePort } from "../src/transport/port.js";

const scope = (): AppLocalScope => ({
  account: "11111111-1111-4111-8111-111111111111",
  installation: "22222222-2222-4222-8222-222222222222",
  collection: "33333333-3333-4333-8333-333333333333",
  isCurrent: () => true,
});
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function channels() {
  const { port1, port2 } = new MessageChannel();
  cleanup.push(() => { port1.close(); port2.close(); });
  return [port1, port2] as unknown as [MessagePort, MessagePort];
}
function fixture(hostScope = scope(), uiScope = scope()) {
  const [host, ui] = channels();
  let closed = false;
  const sent: CborValue[] = [];
  const native: FramePort = {
    onframe: null, onclose: null,
    send(frame) { sent.push(frame); native.onframe?.(frame); },
    close: vi.fn(() => { if (!closed) { closed = true; native.onclose?.(); } }),
  };
  const connect = vi.fn(() => native);
  const attached = attachAppLocalFacade({ connect }, host, hostScope);
  cleanup.push(attached.close);
  const connector = appLocalConnector(ui, uiScope);
  return { native, connect, sent, connector, host, ui };
}
async function received(port: FramePort, send: () => void) {
  return new Promise<CborValue>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("fixture frame timeout")), 1000);
    port.onframe = value => { clearTimeout(timer); resolve(value); };
    send();
  });
}

describe("first-party owned local data facade", () => {
  it("only opens the original native collection and preserves CBOR map/bigint/bytes", async () => {
    const f = fixture();
    const hello = new Map<number, CborValue>([[0, 0], [1, 2]]);
    const opened = await f.connector.open(hello);
    expect(opened.helloResponse).toEqual(hello);
    expect(f.connect).toHaveBeenCalledWith({ collection: scope().collection });
    const bytes = new Uint8Array([4, 5]);
    const frame = new Map<number, CborValue>([[0, 1n << 60n], [1, bytes]]);
    const reply = received(opened.port, () => { opened.port.send(frame); bytes.fill(0); });
    expect(await reply).toEqual(new Map<number, CborValue>([[0, 1n << 60n], [1, new Uint8Array([4, 5])]]));
    expect(f.sent).toHaveLength(2);
    opened.port.close();
    expect(f.native.close).not.toHaveBeenCalled(); // local close travels asynchronously
  });
  it("host close rejects pending hello before terminating its Worker", async () => {
    const f = fixture();
    f.native.send = vi.fn();
    const opening = f.connector.open([0]);
    f.connector.close();
    await expect(opening).rejects.toThrow("app local facade unavailable");
    await expect(f.connector.open([0])).rejects.toThrow("app local facade unavailable");
  });
  it("source-triggered abort cannot send a hello after cancellation", async () => {
    const abort = new AbortController();
    const f = fixture(scope(), { ...scope(), isCurrent: () => { abort.abort(); return true; } });
    await expect(f.connector.open([0], abort.signal)).rejects.toThrow("app local facade unavailable");
    expect(f.sent).toEqual([]);
  });
  it("refuses replaying open without disrupting the first session", async () => {
    const f = fixture(), opened = await f.connector.open([0]);
    await expect(f.connector.open([0])).rejects.toThrow("app local facade unavailable");
    expect(await received(opened.port, () => opened.port.send([2]))).toEqual([2]);
  });
  it("closes before hello if the original scopes disagree", async () => {
    const f = fixture(scope(), { ...scope(), collection: scope().account });
    await expect(f.connector.open([0])).rejects.toThrow("app local facade unavailable");
    expect(f.sent).toEqual([]);
    expect(f.native.close).toHaveBeenCalledOnce();
  });
  it("fences a source changed after hello without forwarding another frame", async () => {
    let current = true;
    const f = fixture({ ...scope(), isCurrent: () => current });
    const opened = await f.connector.open([0]);
    current = false;
    const stopped = new Promise<void>(resolve => { opened.port.onclose = () => resolve(); });
    opened.port.send([2]);
    await stopped;
    expect(f.sent).toEqual([[0]]);
    expect(f.native.close).toHaveBeenCalledOnce();
  });
  it("refuses an already-aborted opening and preserves the original hello", async () => {
    const f = fixture();
    await expect(f.connector.open([0], AbortSignal.abort())).rejects.toThrow("app local facade unavailable");
    expect(f.sent).toEqual([]);
  });
  it("aborts a pending hello and closes the native session", async () => {
    const f = fixture(), abort = new AbortController();
    f.native.send = vi.fn();
    const opening = f.connector.open([0], abort.signal);
    abort.abort();
    await expect(opening).rejects.toThrow("app local facade unavailable");
  });
  it("rejects malformed/raw host control requests before native dispatch", async () => {
    const f = fixture(), opened = await f.connector.open([0]);
    const stopped = new Promise<void>(resolve => { opened.port.onclose = () => resolve(); });
    f.ui.postMessage({ method: "sign", sql: "private fixture should not forward" });
    await stopped;
    expect(f.sent).toEqual([[0]]);
  });
  it("refuses a native-open failure with no internal details", () => {
    const [host] = channels();
    expect(() => attachAppLocalFacade({ connect: () => { throw Error("private fixture detail"); } }, host, scope()))
      .toThrow("app local facade unavailable; reopen and reconcile");
  });
});
