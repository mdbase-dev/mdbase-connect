/**
 * Worker ↔ main-thread bridge for host operations.
 *
 * `runtime.wasm` and sqlite-wasm share the dedicated Worker, so index calls stay
 * synchronous. The vault adapter, IndexedDB-plus-vault journal and editors live on the
 * main thread, so the Worker's {@link HostLoop} forwards every `HostOp` here and gets
 * the `HostDone` back.
 *
 * Messages carry structured-cloneable values only. `FsError` and `JournalError`
 * instances are flattened to `{kind, detail}` and rebuilt on the other side, so the
 * store still branches on the right kind.
 */

import { FsError } from "../vault/types.js";
import type { HostDone, HostOp } from "./driver.js";

/** The `postMessage` surface of a Worker, `self` in a Worker, or a `MessagePort`. */
export interface PortLike {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  removeEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
}

const TAG = "mdbase-host";

type Wire = { t: typeof TAG; id: number; op?: HostOp; done?: unknown };

function flatten(done: HostDone): unknown {
  if (done.kind === "File" && !done.result.ok) {
    return { kind: "File", result: { ok: false, error: { kind: done.result.error.kind, detail: done.result.error.detail } } };
  }
  return done;
}

function rebuild(raw: unknown): HostDone {
  const d = raw as HostDone;
  if (d.kind === "File" && !d.result.ok) {
    const e = d.result.error as unknown as { kind: FsError["kind"]; detail: string };
    return { kind: "File", result: { ok: false, error: new FsError(e.kind, e.detail) } };
  }
  return d;
}

/** Main thread: answer host operations arriving on `port` with `perform`. */
export function serveHostOps(port: PortLike, perform: (op: HostOp) => Promise<HostDone>): () => void {
  const onMessage = (ev: { data: unknown }) => {
    const m = ev.data as Wire;
    if (!m || m.t !== TAG || !m.op) return;
    void perform(m.op).then((done) => port.postMessage({ t: TAG, id: m.id, done: flatten(done) } satisfies Wire));
  };
  port.addEventListener("message", onMessage);
  return () => port.removeEventListener("message", onMessage);
}

/** Worker: a `perform` that forwards to the main thread over `port`. */
export function remoteHostOps(port: PortLike): { perform(op: HostOp): Promise<HostDone>; close(): void } {
  let next = 1;
  const waiting = new Map<number, (d: HostDone) => void>();
  const onMessage = (ev: { data: unknown }) => {
    const m = ev.data as Wire;
    if (!m || m.t !== TAG || m.done === undefined) return;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    w(rebuild(m.done));
  };
  port.addEventListener("message", onMessage);
  return {
    perform(op) {
      const id = next++;
      return new Promise<HostDone>((resolve) => {
        waiting.set(id, resolve);
        port.postMessage({ t: TAG, id, op } satisfies Wire);
      });
    },
    close() {
      port.removeEventListener("message", onMessage);
    },
  };
}
