import { describe, expect, it } from "vitest";
import {
  connect, decode, encode, wire,
  type CborValue, type Connector, type FileView, type FramePort,
  type MdbaseClient, type OpenedPort,
} from "../src/thin-client.js";

// SOURCE/public API regression: only the Connector/FramePort peer is synthetic.
// No Session/FilesApi replacement, spies, native runtime or disposal claim.
const app = { name: "download-cancel-wire-test", version: "0.0.0" };
const streamId = 73;
const bytes = new Uint8Array([1, 2, 3]);
const view: FileView = {
  id: "0192f3a4-6000-7abc-8def-0123456789ab", path: "files/source.bin", size: 3,
  digest: "sha256:039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
  media: "other", state: "materialized", confirmedSeq: 0,
  contentProfile: "ordinary_blob",
};
const hello: wire.HelloResult = {
  version: { major: 1, minor: 2 }, runtimeVersion: "synthetic-wire-peer",
  sem: { major: 1, minor: 0 }, collection: "0192f3a4-6000-7abc-8def-0123456789ac",
  grant: { capabilities: ["collection.read"], role: "viewer" }, features: [],
  status: {
    mode: "local_only", confirmedThrough: 0, headKnown: 0, pending: 0,
    holds: 0, unresolved: 0, connection: "online", incidents: [],
  },
};

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// Timers are watchdogs ONLY, never the interleaving mechanism.
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bounded completion failed: ${label}`)), 1000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

// Event-loop fence drains the finite SDK microtasks; no polling/sleep lottery.
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));
const roundTrip = (value: CborValue) => decode(encode(value));
function printable(value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: [...value] };
  if (value instanceof Map) return [...value].map(([k, v]) => [k, printable(v)]);
  if (value instanceof Error) return { name: value.name, message: value.message, code: (value as { code?: string }).code };
  if (Array.isArray(value)) return value.map(printable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, printable(v)]));
  return value;
}

type Request = Extract<wire.ClientFrame, { kind: "request" }> & { session: number };
class WirePeer {
  readonly events: unknown[] = [];
  readonly requests: Request[] = [];
  readonly ports: FramePort[] = [];
  readonly read = gate<Request>();
  private nextOpen: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | undefined;
  note(event: string, detail: unknown = {}) { this.events.push({ order: this.events.length, event, ...detail as object }); }

  readonly connector: Connector = {
    description: "hermetic-download-cancel-wire",
    open: async raw => {
      const session = this.ports.length + 1; // fixture connection ordinal, NOT a native session ID
      const request = wire.clientFrame.dec(roundTrip(raw));
      expect(request).toMatchObject({ kind: "request", method: "hello", id: 0 });
      if (request.kind !== "request") throw new Error("expected hello request");
      wire.helloParams.dec(request.params);
      this.note("hello-request", { session, frame: request });
      let closed = false;
      const port: FramePort = {
        onframe: null, onclose: null,
        send: raw => {
          if (closed) throw new Error("synthetic port closed");
          const frame = wire.clientFrame.dec(roundTrip(raw));
          this.note("client-frame", { session, frame });
          if (frame.kind !== "request") throw new Error("unexpected non-request");
          const request = { ...frame, session };
          this.requests.push(request);
          if (frame.method === "read_file") this.read.resolve(request);
          else if (["cancel", "cancel_stream", "ack_chunks"].includes(frame.method)) {
            // Reply asynchronously, as a real peer may. Never alter SDK handlers.
            queueMicrotask(() => { if (!closed) this.respond(request, null); });
          } else throw new Error(`unexpected method: ${frame.method}`);
        },
        close: () => {
          if (closed) return;
          closed = true;
          this.note("port-close", { session });
          port.onclose?.();
        },
      };
      this.ports.push(port);
      const wait = this.nextOpen;
      this.nextOpen = undefined;
      if (wait) {
        wait.entered.resolve();
        await wait.release.promise;
      }
      const result = roundTrip(wire.helloResult.enc(hello));
      expect(wire.helloResult.dec(result)).toEqual(hello);
      this.note("hello-response", { session, collection: hello.collection });
      return { port, helloResponse: roundTrip(wire.clientFrame.enc({ kind: "response", id: 0, result })) } satisfies OpenedPort;
    },
  };

  pauseNextOpen() {
    const wait = { entered: gate<void>(), release: gate<void>() };
    this.nextOpen = wait;
    return wait;
  }
  respond(request: Request, result: CborValue) {
    const frame = wire.clientFrame.enc({ kind: "response", id: request.id, result });
    this.note("server-response-delivery", { session: request.session, requestId: request.id, method: request.method, result });
    const handler = this.ports[request.session - 1]!.onframe;
    if (!handler) throw new Error("real Session handler was not installed");
    handler(roundTrip(frame));
    this.note("real-response-handler-returned", { session: request.session, requestId: request.id, method: request.method });
  }
  replyRead(request: Request, beforeStartContinuation?: () => void) {
    const metadata = roundTrip(wire.fileView.enc(view));
    expect(wire.fileView.dec(metadata)).toEqual(view);
    this.respond(request, new Map<number, CborValue>([[0, streamId], [1, metadata]]));
    // Session.onFrame -> pending.resolve has returned; its await continuation
    // cannot run until this JS stack yields. This is the deterministic race gate.
    this.note("response-settled-before-start-continuation", { streamId });
    beforeStartContinuation?.();
  }
  chunk(request: Request, last = true) {
    this.note("server-chunk", { session: request.session, streamId, last });
    this.ports[request.session - 1]!.onframe!(roundTrip(wire.clientFrame.enc({
      kind: "push", type: "file_chunk", payload: wire.fileChunk.enc({ stream: streamId, offset: 0, bytes, last }),
    })));
  }
  matching(method: string) { return this.requests.filter(r => r.method === method); }
  streamCancels(request: Request) {
    return this.matching("cancel_stream").filter(r => r.session === request.session && r.params instanceof Map && (r.params as Map<number, CborValue>).get(0) === streamId);
  }
  requestCancels(request: Request) {
    return this.matching("cancel").filter(r => r.session === request.session && r.params instanceof Map && (r.params as Map<number, CborValue>).get(0) === request.id);
  }
}

function observe<T>(peer: WirePeer, label: string, promise: Promise<T>) {
  let state = "pending";
  // Attach both branches immediately, including reader.closed/file rejection.
  const done = promise.then(value => {
    state = "fulfilled";
    peer.note(`${label}-fulfilled`, { value });
    return { state: "fulfilled" as const, value };
  }, error => {
    state = "rejected";
    peer.note(`${label}-rejected`, { error });
    return { state: "rejected" as const, error };
  });
  return { done, state: () => state };
}
function download(client: MdbaseClient, peer: WirePeer, signal?: AbortSignal) {
  const stream = client.files.downloadStream({ path: view.path }, { signal });
  const reader = stream.getReader();
  const file = observe(peer, "file", stream.file);
  const closed = observe(peer, "reader-closed", reader.closed);
  return { stream, reader, file, closed };
}
function cancel(peer: WirePeer, reader: ReadableStreamDefaultReader<Uint8Array>) {
  peer.note("reader-cancel-called");
  return observe(peer, "reader-cancel", reader.cancel("test cancellation")).done;
}
function abort(peer: WirePeer, controller: AbortController) {
  peer.note("signal-abort-called");
  controller.abort();
}
async function withPeer(name: string, body: (peer: WirePeer, client: MdbaseClient) => Promise<void>, reconnect: false | Record<string, never> = false) {
  const peer = new WirePeer();
  const client = await bounded(connect({ connector: peer.connector, app, reconnect }), "connect");
  try { await body(peer, client); }
  finally {
    client.close();
    await checkpoint();
    expect(client.link).toBe("closed");
    peer.note("teardown-complete");
    console.log(`DOWNLOAD_CANCEL_TRACE ${name} ${JSON.stringify(printable(peer.events))}`);
  }
}

// Strict cancellation assertions deliberately remain RED against the unfixed SDK.
describe("files.downloadStream public wire cancellation", () => {
  it("control: valid hello/FileView, bytes, ACK and EOF without cancellation", async () => {
    await withPeer("normal", async (peer, client) => {
      const d = download(client, peer);
      const request = await bounded(peer.read.promise, "read_file request");
      expect(request.params).toEqual(new Map([[0, view.path]]));
      peer.replyRead(request);
      expect(await bounded(d.file.done, "file")).toEqual({ state: "fulfilled", value: view });
      const read = observe(peer, "read", d.reader.read());
      peer.chunk(request);
      expect(await bounded(read.done, "read")).toEqual({ state: "fulfilled", value: { done: false, value: bytes } });
      expect(await bounded(d.reader.read(), "EOF")).toEqual({ done: true, value: undefined });
      expect((await bounded(d.closed.done, "closed")).state).toBe("fulfilled");
      await checkpoint();
      expect(peer.matching("ack_chunks").map(r => r.params)).toEqual([new Map([[0, streamId], [1, bytes.length]])]);
      expect(peer.matching("cancel_stream")).toHaveLength(0);
    });
  });

  it("control: pre-aborted signal rejects metadata/reader without read_file", async () => {
    await withPeer("pre-aborted-signal", async (peer, client) => {
      const controller = new AbortController();
      abort(peer, controller);
      const d = download(client, peer, controller.signal);
      const read = observe(peer, "read", d.reader.read());
      for (const result of await bounded(Promise.all([d.file.done, d.closed.done, read.done]), "aborted outcomes")) {
        expect(result).toMatchObject({ state: "rejected", error: { code: "cancelled" } });
      }
      expect(peer.matching("read_file")).toHaveLength(0);
    });
  });

  it("control: signal abort before reply sends cancel for the original request ID", async () => {
    await withPeer("pre-response-signal", async (peer, client) => {
      const controller = new AbortController();
      const d = download(client, peer, controller.signal);
      const request = await bounded(peer.read.promise, "read_file request");
      const read = observe(peer, "read", d.reader.read());
      abort(peer, controller);
      for (const result of await bounded(Promise.all([d.file.done, d.closed.done, read.done]), "abort outcomes")) {
        expect(result).toMatchObject({ state: "rejected", error: { code: "cancelled" } });
      }
      expect(peer.requestCancels(request)).toHaveLength(1);
      expect(peer.matching("cancel_stream")).toHaveLength(0);
    });
  });

  it("control: reader.cancel after metadata cancels the exact session/stream", async () => {
    await withPeer("post-metadata-reader", async (peer, client) => {
      const d = download(client, peer);
      const request = await bounded(peer.read.promise, "read_file request");
      peer.replyRead(request);
      expect((await bounded(d.file.done, "file")).state).toBe("fulfilled");
      expect(await bounded(cancel(peer, d.reader), "cancel")).toEqual({ state: "fulfilled", value: undefined });
      expect((await bounded(d.closed.done, "closed")).state).toBe("fulfilled");
      peer.chunk(request);
      await checkpoint();
      expect(peer.streamCancels(request)).toHaveLength(1);
      expect(peer.matching("ack_chunks")).toHaveLength(0);
    });
  });

  it("reader.cancel before the session acquisition continuation must not orphan later work", async () => {
    await withPeer("pre-acquisition-reader", async (peer, client) => {
      const d = download(client, peer);
      // No await: async start is still awaiting FilesApi.session, no read_file yet.
      expect(peer.matching("read_file")).toHaveLength(0);
      const cancelled = cancel(peer, d.reader);
      await checkpoint();
      const request = peer.matching("read_file")[0];
      if (request) peer.replyRead(request);
      await bounded(Promise.all([cancelled, d.file.done, d.closed.done]), "pre-acquisition outcomes");
      await checkpoint();
      expect(request ? peer.requestCancels(request).length + peer.streamCancels(request).length : 1,
        "suppress read_file or remotely cancel its original request/stream").toBeGreaterThan(0);
    });
  });

  it("reader.cancel while the real session is reconnecting must not orphan late read_file", async () => {
    await withPeer("before-session-open-reader", async (peer, client) => {
      const opening = peer.pauseNextOpen();
      peer.ports[0]!.close();
      await bounded(opening.entered.promise, "reconnect entered");
      expect(client.link).toBe("reconnecting");
      const d = download(client, peer);
      const cancelled = cancel(peer, d.reader);
      await bounded(cancelled, "cancel before open");
      expect(peer.matching("read_file")).toHaveLength(0);
      peer.note("release-reconnect-hello");
      opening.release.resolve();
      await checkpoint();
      const request = peer.matching("read_file")[0];
      if (request) peer.replyRead(request);
      await bounded(Promise.all([d.file.done, d.closed.done]), "late open outcomes");
      await checkpoint();
      expect(request ? peer.requestCancels(request).length + peer.streamCancels(request).length : 1,
        "suppress read_file or remotely cancel its original request/stream").toBeGreaterThan(0);
    }, {});
  });

  it("reader.cancel before read_file response must cancel pending or late stream", async () => {
    await withPeer("pre-response-reader", async (peer, client) => {
      const d = download(client, peer);
      const request = await bounded(peer.read.promise, "read_file request");
      const cancelled = cancel(peer, d.reader);
      await bounded(cancelled, "cancel before response");
      peer.replyRead(request);
      await bounded(Promise.all([d.file.done, d.closed.done]), "late metadata/closed");
      await checkpoint();
      expect(peer.requestCancels(request).length + peer.streamCancels(request).length,
        "original pending request or returned stream must be remotely cancelled").toBeGreaterThan(0);
    });
  });

  it.each(["reader", "signal", "signal-and-reader"] as const)(
    "%s cancellation after real response settlement but before start continuation cancels returned stream",
    async mode => {
      await withPeer(`response-gap-${mode}`, async (peer, client) => {
        const controller = new AbortController();
        const d = download(client, peer, controller.signal);
        const request = await bounded(peer.read.promise, "read_file request");
        let cancelled: ReturnType<typeof cancel> | undefined;
        peer.replyRead(request, () => {
          expect(d.file.state()).toBe("pending");
          if (mode !== "reader") abort(peer, controller);
          if (mode !== "signal") cancelled = cancel(peer, d.reader);
          // All of the above occurs in the delivery stack, not a later .then.
          expect(d.file.state()).toBe("pending");
          peer.note("cancellation-returned-before-metadata-continuation");
        });
        if (cancelled) await bounded(cancelled, "cancel");
        await bounded(d.file.done, "file after race");
        const read = observe(peer, "read", d.reader.read());
        peer.chunk(request);
        const readOutcome = await bounded(read.done, "read after race");
        await bounded(d.closed.done, "closed after race");
        await checkpoint();
        // Soft assertions collect BOTH the missing remote frame and any late bytes.
        expect.soft(peer.streamCancels(request), "must cancel exact returned stream 73 on original session").toHaveLength(1);
        expect.soft(peer.matching("ack_chunks"), "must not consume/ACK bytes after cancellation").toHaveLength(0);
        expect.soft(readOutcome.state === "rejected" || (readOutcome.state === "fulfilled" && readOutcome.value.done),
          "cancelled reader must not publish file bytes").toBe(true);
      });
    },
  );

  it("signal-only abort after metadata must stop the stream (not just read_file request)", async () => {
    await withPeer("post-metadata-signal", async (peer, client) => {
      const controller = new AbortController();
      const d = download(client, peer, controller.signal);
      const request = await bounded(peer.read.promise, "read_file request");
      peer.replyRead(request);
      expect((await bounded(d.file.done, "file")).state).toBe("fulfilled");
      abort(peer, controller);
      const read = observe(peer, "read", d.reader.read());
      peer.chunk(request);
      const result = await bounded(read.done, "read after signal");
      await bounded(d.closed.done, "closed");
      await checkpoint();
      expect.soft(peer.streamCancels(request)).toHaveLength(1);
      expect.soft(peer.matching("ack_chunks")).toHaveLength(0);
      expect.soft(result.state === "rejected" || (result.state === "fulfilled" && result.value.done)).toBe(true);
    });
  });

  it("control: defer the FIRST original reader.cancel until metadata settles after gap signal abort", async () => {
    await withPeer("deferred-first-reader-cancel", async (peer, client) => {
      const controller = new AbortController();
      const d = download(client, peer, controller.signal);
      const request = await bounded(peer.read.promise, "read_file request");
      peer.replyRead(request, () => abort(peer, controller));
      const metadata = await bounded(d.file.done, "file");
      // A fixed SDK may already reject metadata on signal abort. Do not require
      // today's late fulfillment as part of this workaround control.
      if (metadata.state === "rejected") expect(metadata.error).toMatchObject({ code: "cancelled" });
      await bounded(cancel(peer, d.reader), "deferred first cancel");
      await bounded(d.closed.done, "closed");
      await checkpoint();
      expect(peer.streamCancels(request)).toHaveLength(1);
    });
  });
});
