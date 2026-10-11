/** Required actor-profile restriction only, not original-principal/CP admission.
 * Captures this actor's native namespace/ID and external phase before any custody
 * construction. No keys, SQL, public permit or operator endpoint is installed.
 */
import { parsePitrBinding, readPitrPhase, type PitrBinding, type PitrMember } from "./pitr-phase.ts";
import { PitrCut, type PitrWork } from "./pitr-cut.ts";
import type { PitrFactorySettings } from "./pitr-factory.ts";

type Settings = PitrFactorySettings & {
  COLLECTIONS: Pick<DurableObjectNamespace, "idFromName">;
  PITR_PHASE?: Pick<R2Bucket, "get">;
};
const refuse = (): never => { throw new Error("pitr_actor_closed"); };
type PrekeyNative = {
  begin(request: Request): Promise<Uint8Array>;
  accept(handle: number, envelope: Uint8Array): void;
  current(handle: number): void;
  finish(handle: number): void;
};
type CpSource = { origin: string; authority(): unknown; fetch: typeof fetch };

// Local sequencing DATA only. No witness/caller is serialized across WASM.
function prekeyData(bytes: Uint8Array): { handle: number; challenge: string } {
  if (!(bytes instanceof Uint8Array) || bytes.length > 44 || bytes[0] !== 0x82) refuse();
  let offset = 1;
  const head = bytes[offset++];
  if (head === undefined || head > 0x1b) refuse();
  let handle = BigInt(head);
  if (head >= 0x18) {
    const width = 2 ** (head - 0x18);
    if (offset + width > bytes.length) refuse();
    handle = 0n;
    for (let i = 0; i < width; i++) handle = (handle << 8n) | BigInt(bytes[offset++]!);
    const minimum = width === 1 ? 24n : 1n << BigInt(8 * (width / 2));
    if (handle < minimum) refuse();
  }
  if (handle < 1n || handle > BigInt(Number.MAX_SAFE_INTEGER)
      || bytes[offset++] !== 0x58 || bytes[offset++] !== 32 || offset + 32 !== bytes.length) refuse();
  const challenge = bytes.subarray(offset);
  if (!challenge.some(byte => byte !== 0)) refuse();
  return Object.freeze({ handle: Number(handle), challenge: Array.from(challenge, b => b.toString(16).padStart(2, "0")).join("") });
}
function cpEnvelope(bytes: Uint8Array): Uint8Array {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.admission !== "string"
      || typeof record.expires_at !== "number" || !Number.isSafeInteger(record.expires_at) || record.expires_at < 0
      || record.admission.length === 0 || record.admission.length > 5464
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.admission)) return refuse();
  const raw = atob(record.admission);
  if (raw.length === 0 || raw.length > 4096 || btoa(raw) !== record.admission) refuse();
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

export class PitrActorRestriction {
  private constructor(private readonly state: DurableObjectState,
    private readonly namespace: Settings["COLLECTIONS"], private readonly bucket: Pick<R2Bucket, "get">,
    private readonly binding: PitrBinding, private readonly member: PitrMember,
    private readonly minimumEpoch: number, private readonly work: PitrWork) {}

  static from(state: DurableObjectState, env: Settings, work: PitrWork): PitrActorRestriction | null {
    // Validate public profile first; missing/partial config never reads custody
    // settings, namespace, R2, stored collection labels or actor SQL.
    const binding = parsePitrBinding(env.PITR_BINDING);
    if (!binding || env.LAB !== "1" || env.SERVICE_KIND !== "hosted"
        || !/^[1-9][0-9]{0,15}$/.test(env.PITR_MINIMUM_EPOCH ?? "")) return null;
    const minimumEpoch = Number(env.PITR_MINIMUM_EPOCH);
    if (!Number.isSafeInteger(minimumEpoch)) return null;
    try {
      const namespace = env.COLLECTIONS;
      const matches = binding.members.filter(m => m.kind === "hosted"
        && state.id.equals(namespace.idFromName(m.collection)) && state.id.toString() === m.object);
      if (matches.length !== 1 || !env.PITR_PHASE) return null;
      const restriction = new PitrActorRestriction(state, namespace, env.PITR_PHASE,
        binding, matches[0]!, minimumEpoch, work);
      restriction.assertPhysical();
      return restriction;
    } catch { return null; }
  }

  /** Required LOG A/D/nil profile. The wrapper supplies the existing REQUIRED
   * flag; no ordinary LOG constructor or secret/config getter is admitted here. */
  static fromLog(state: DurableObjectState, env: Pick<PitrFactorySettings, "PITR_BINDING" | "PITR_MINIMUM_EPOCH"> & {
    LOG: Pick<DurableObjectNamespace, "idFromName">; PITR_PHASE?: Pick<R2Bucket, "get">;
    LOGSVC_PITR_REQUIRED?: string;
  }, work: PitrWork): PitrActorRestriction | null {
    const binding = parsePitrBinding(env.PITR_BINDING);
    if (!binding || env.LOGSVC_PITR_REQUIRED !== "1"
        || typeof env.PITR_MINIMUM_EPOCH !== "string"
        || !/^[1-9][0-9]{0,15}$/.test(env.PITR_MINIMUM_EPOCH)) return null;
    const minimumEpoch = Number(env.PITR_MINIMUM_EPOCH);
    if (!Number.isSafeInteger(minimumEpoch)) return null;
    try {
      const namespace = env.LOG;
      const matches = binding.members.filter(m => m.kind !== "hosted"
        && state.id.equals(namespace.idFromName(m.collection)) && state.id.toString() === m.object);
      if (matches.length !== 1 || !env.PITR_PHASE) return null;
      const restriction = new PitrActorRestriction(state, namespace, env.PITR_PHASE,
        binding, matches[0]!, minimumEpoch, work);
      restriction.assertPhysical();
      return restriction;
    } catch { return null; }
  }

  /** Native same-namespace equality, not equal strings or a stored device ID.
   * Configured namespace labels remain deployment DATA, not provider-ID proof.
   */
  assertPhysical(): void {
    if (!this.state.id.equals(this.namespace.idFromName(this.member.collection))
        || this.state.id.toString() !== this.member.object) refuse();
  }

  private readonly getPhase = async () => {
    this.assertPhysical();
    const object = await this.bucket.get(`${this.binding.run}/phase.json`);
    // readPitrPhase owns late-body cleanup. Do not discard a body here on drift.
    return object && "body" in object ? { size: object.size, body: object.body } : null;
  };

  /** Fixed activation restriction, never a caller-selected phase/permission. */
  async assertSeedCurrent(collection: string, signal: AbortSignal): Promise<void> {
    await this.seedPoint(collection, signal);
  }
  private async seedPoint(collection: string, signal: AbortSignal): Promise<{ epoch: number; issuedAt: number; expiresAt: number }> {
    this.assertPhysical();
    if (signal.aborted || collection !== this.member.collection) refuse();
    const phase = await readPitrPhase(this.getPhase, this.binding, Date.now, () => this.minimumEpoch,
      fn => this.work.trackClosed(fn));
    this.assertPhysical();
    if (signal.aborted || !phase || phase.phase !== "seed") return refuse();
    return { epoch: phase.epoch, issuedAt: phase.issuedAt, expiresAt: phase.expiresAt };
  }

  /** Observe CP-only signed DATA in this CLOSED callback. Native independently
   * authenticates the retained real request; even success cannot serve or key SQL.
   * A caller deadline bounds return, not settlement: the SAME work retains every
   * late native/get/read/cancel continuation through matching finish/finally.
   */
  async observeOriginalCp(request: Request, signal: AbortSignal, native: PrekeyNative,
    source: CpSource, checkCallback: () => void): Promise<void> {
    if (this.member.kind !== "log") refuse(); // Nil has no OriginalPins admission.
    const abort = new AbortController();
    let live = true;
    const started = Date.now();
    if (!Number.isSafeInteger(started) || started < 0) refuse();
    let rejectDeadline: (reason: Error) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const stop = () => { live = false; abort.abort(); rejectDeadline(new Error("pitr_actor_closed")); };
    const timer = setTimeout(stop, 5000);
    signal.addEventListener("abort", stop, { once: true });
    request.signal.addEventListener("abort", stop, { once: true });
    const check = () => {
      this.assertPhysical();
      checkCallback();
      const now = Date.now();
      if (!live || signal.aborted || request.signal.aborted || !Number.isSafeInteger(now)
          || now < started || now - started >= 5000) refuse();
    };
    try {
      const pending = this.work.trackClosed(async () => {
        let handle: number | undefined;
        let response: Response | undefined;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let complete = false;
        try {
          check();
          const initial = await this.seedPoint(this.member.collection, signal);
          check();
          const verifyPoint = async () => {
            check();
            const point = await this.seedPoint(this.member.collection, signal);
            check();
            if (point.epoch !== initial.epoch || point.issuedAt !== initial.issuedAt || point.expiresAt !== initial.expiresAt) refuse();
          };
          const data = prekeyData(await native.begin(request));
          handle = data.handle;
          check();
          await verifyPoint();
          const token = source.authority(); // Existing transport bearer, not a signing/custody key.
          if (typeof token !== "string" || !/^[!-~]{16,4096}$/.test(token)) refuse();
          response = await source.fetch(`${source.origin}/internal/v1/next/lab-pitr/original-cp-admission`, {
            method: "POST", redirect: "error", cache: "no-store", signal: abort.signal,
            headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ collection: this.member.collection, challenge: data.challenge }),
          });
          check();
          if (response.status !== 200 || response.redirected || response.headers.get("cache-control") !== "no-store" || !response.body) return refuse();
          reader = response.body.getReader();
          const bytes = new Uint8Array(4096);
          let length = 0;
          for (let reads = 0; reads < 64; reads++) {
            check();
            const part = await reader.read();
            check();
            if (part.done) { complete = true; break; }
            if (!(part.value instanceof Uint8Array) || part.value.length > bytes.length - length) refuse();
            bytes.set(part.value, length); length += part.value.length;
          }
          if (!complete) refuse();
          const envelope = cpEnvelope(bytes.subarray(0, length));
          await verifyPoint();
          native.accept(handle, envelope); // VOID: never a host-created witness/ACK.
          check();
          native.current(handle);
          check();
          await verifyPoint();
          native.current(handle);
          check();
        } finally {
          // Cleanup belongs to the original tracked continuation, even after abort
          // or deadline. Neither cancellation nor native finish is cut settlement.
          try {
            if (reader) {
              if (!complete) { try { await reader.cancel(); } catch {} }
              try { reader.releaseLock(); } catch {}
            } else if (response?.body) { try { await response.body.cancel(); } catch {} }
          } finally { if (handle !== undefined) native.finish(handle); }
        }
      });
      await Promise.race([pending, deadline]);
    } finally {
      live = false; clearTimeout(timer); abort.abort();
      signal.removeEventListener("abort", stop);
      request.signal.removeEventListener("abort", stop);
    }
  }

  /** Internal mechanics only. Same actor, same work and physical context; no
   * transport exposes this object until independent operator authorization exists.
   */
  cut(stopResources: () => void): PitrCut {
    this.assertPhysical();
    return new PitrCut(this.state, {binding:this.binding,member:this.member,minimumEpoch:this.minimumEpoch},
      this.getPhase, this.work, stopResources, Date.now, () => this.assertPhysical());
  }
}
