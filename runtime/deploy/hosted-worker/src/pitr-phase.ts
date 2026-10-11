/** Isolated LAB recovery restriction only; never a substitute for live CP authorization.
 * Read from the operator-held R2 object, not restored DO storage or request flags.
 * Both the runtime binding and each record name the exact five admitted objects.
 */
export const PITR_RUN = "gate4-pitr-lab-20261009-01";
const NIL = "00000000-0000-0000-0000-000000000000";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BYTES = 4096;
const MAX_READS = 64;
const IO_DEADLINE_MS = 5000;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
const PHASES = ["closed", "seed", "mutate", "authority", "readback"] as const;
type Phase = typeof PHASES[number];
export interface PitrMember {
  kind: "log" | "hosted" | "registry";
  collection: string;
  namespace: string;
  object: string;
}
export interface PitrBinding {
  run: typeof PITR_RUN;
  active: string;
  deleted: string;
  codeConfigSha256: string;
  members: readonly PitrMember[];
}
export interface PitrPhase {
  schema: "mdbn-lab-pitr-phase/1";
  binding: PitrBinding;
  epoch: number;
  phase: Phase;
  issuedAt: number;
  expiresAt: number;
}
type Dict = Record<string, unknown>;
function dict(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Dict, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}
function memberKey(m: PitrMember): string {
  return `${m.kind}/${m.collection}/${m.namespace}/${m.object}`;
}
function bindingValid(value: unknown): value is PitrBinding {
  if (!dict(value) || !exact(value, ["run", "active", "deleted", "codeConfigSha256", "members"])
      || value.run !== PITR_RUN || typeof value.active !== "string" || typeof value.deleted !== "string"
      || !UUID.test(value.active) || !UUID.test(value.deleted) || value.active === NIL || value.deleted === NIL
      || value.active === value.deleted || typeof value.codeConfigSha256 !== "string"
      || !HEX64.test(value.codeConfigSha256) || !Array.isArray(value.members) || value.members.length !== 5) return false;
  const members: PitrMember[] = [];
  for (const m of value.members) {
    if (!dict(m) || !exact(m, ["kind", "collection", "namespace", "object"])
        || typeof m.kind !== "string" || !["log", "hosted", "registry"].includes(m.kind) || typeof m.collection !== "string"
        || typeof m.namespace !== "string" || !HEX32.test(m.namespace)
        || typeof m.object !== "string" || !HEX64.test(m.object)) return false;
    members.push({ kind: m.kind as PitrMember["kind"], collection: m.collection,
      namespace: m.namespace, object: m.object });
  }
  const pairs = members.map(m => `${m.kind}/${m.collection}`).sort();
  const expected = [`log/${value.active}`, `log/${value.deleted}`, `hosted/${value.active}`,
    `hosted/${value.deleted}`, `registry/${NIL}`].sort();
  if (pairs.some((v, i) => v !== expected[i])
      || new Set(members.map(m => `${m.namespace}/${m.object}`)).size !== 5) return false;
  const log = members.filter(m => m.kind !== "hosted");
  const hosted = members.filter(m => m.kind === "hosted");
  return log.every(m => m.namespace === log[0]!.namespace)
    && hosted.every(m => m.namespace === hosted[0]!.namespace)
    && log[0]!.namespace !== hosted[0]!.namespace;
}
/** Deployment configuration only; never decoded from a request or restored SQL. */
export function parsePitrBinding(text: string | undefined): PitrBinding | null {
  if (text === undefined || new TextEncoder().encode(text).length > MAX_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!bindingValid(value)) return null;
  return Object.freeze({ run: value.run, active: value.active, deleted: value.deleted,
    codeConfigSha256: value.codeConfigSha256,
    members: Object.freeze(value.members.map(m => Object.freeze({ ...m }))) });
}
function sameBinding(a: PitrBinding, b: PitrBinding): boolean {
  const expected = b.members.map(memberKey).sort();
  return a.run === b.run && a.active === b.active && a.deleted === b.deleted
    && a.codeConfigSha256 === b.codeConfigSha256
    && a.members.map(memberKey).sort().every((v, i) => v === expected[i]);
}
/** null means CLOSED, including malformed configuration. No exceptions contain input. */
export function parsePitrPhase(text: string | null, binding: PitrBinding, now: number,
  minimumEpoch: number): PitrPhase | null {
  if (text === null || new TextEncoder().encode(text).length > MAX_BYTES
      || !bindingValid(binding) || !Number.isSafeInteger(now) || now < 0
      || !Number.isSafeInteger(minimumEpoch) || minimumEpoch < 1) return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!dict(value) || !exact(value, ["schema", "binding", "epoch", "phase", "issuedAt", "expiresAt"])
      || value.schema !== "mdbn-lab-pitr-phase/1" || !bindingValid(value.binding)
      || !sameBinding(binding, value.binding) || !Number.isSafeInteger(value.epoch)
      || typeof value.epoch !== "number" || value.epoch < minimumEpoch
      || !PHASES.includes(value.phase as Phase) || typeof value.issuedAt !== "number"
      || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.issuedAt)
      || !Number.isSafeInteger(value.expiresAt) || value.issuedAt < 0 || value.issuedAt > now
      || value.expiresAt <= now || value.expiresAt <= value.issuedAt
      || value.expiresAt - value.issuedAt > MAX_LIFETIME_MS) return null;
  // Reconstruct rather than handing a caller-provided object to runtime code.
  return { schema: "mdbn-lab-pitr-phase/1", binding: { run: PITR_RUN, active: binding.active,
    deleted: binding.deleted, codeConfigSha256: binding.codeConfigSha256,
    members: binding.members.map(m => ({ ...m })) }, epoch: value.epoch, phase: value.phase as Phase,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt };
}
type PitrObject = { size: number; body: ReadableStream<Uint8Array> };
/** Fixed accumulation/read-work and one get/read/cleanup deadline. The transport
 * must honor the abort signal where supported; a timeout never authorizes a late
 * result. Late bodies are cancelled without extending the caller's deadline.
 */
export async function readPitrPhase(get: (signal: AbortSignal) => Promise<PitrObject | null>,
  binding: PitrBinding, clock: () => number, minimumEpoch: () => number,
  track: <T>(fn: () => Promise<T>) => Promise<T> = fn => fn()): Promise<PitrPhase | null> {
  if (!bindingValid(binding)) return null;
  // Never borrow configured membership across external I/O.
  const snapshot: PitrBinding = { run: binding.run, active: binding.active, deleted: binding.deleted,
    codeConfigSha256: binding.codeConfigSha256, members: binding.members.map(m => ({ ...m })) };
  const abort = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; abort.abort(); reject(new Error("pitr_read_closed")); }, IO_DEADLINE_MS);
  });
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
  const cancel = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    try { await bounded(track(() => body.cancel())); } catch { /* Cancellation cannot extend the deadline. */ }
  };
  let object: PitrObject | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    object = await bounded(track(() => get(abort.signal).then(async result => {
      if (!expired) return result;
      if (result) await cancel(result.body);
      return null;
    })));
    if (!object || !Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_BYTES) return null;
    reader = object.body.getReader();
    const bytes = new Uint8Array(MAX_BYTES);
    let length = 0;
    for (let reads = 0; reads < MAX_READS; reads++) {
      const part = await bounded(track(() => reader!.read()));
      if (part.done) { complete = true; break; }
      if (part.value.length > MAX_BYTES - length) return null;
      bytes.set(part.value, length);
      length += part.value.length;
    }
    if (!complete || length !== object.size || expired) return null;
    const phase = parsePitrPhase(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, length)),
      snapshot, clock(), minimumEpoch());
    return bindingValid(binding) && sameBinding(snapshot, binding) ? phase : null;
  } catch { return null; }
  finally {
    if (reader) {
      if (!complete) { try { await bounded(track(() => reader!.cancel())); } catch { /* CLOSED. */ } }
      try { reader.releaseLock(); } catch { /* CLOSED; no cached permit. */ }
    } else if (object) { await cancel(object.body); }
    clearTimeout(timer!);
    abort.abort();
  }
}
