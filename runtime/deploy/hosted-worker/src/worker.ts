/**
 * The hosted Worker: one Durable Object per cloud-copy collection
 * (`idFromName(collection)`), running the hosted engine over its SQLite.
 *
 * Lifecycle of a DO instance (wake):
 * 1. custody opens the service device keys into memory (no key in SQL, storage,
 *    WebSocket attachments or globals);
 * 2. the engine opens over the cache and rebuilds from the log (snapshot + tail)
 *    through the log Worker; it serves nothing until `serving()` and admission
 *    both allow;
 * 3. writes are answered only after the log append (hosted mode);
 * 4. on hibernation/eviction everything in RAM is gone: sockets from before the
 *    wake are closed (clients re-handshake), the cache is reused or rebuilt.
 *
 * Until Noise-in-Wasm and the verified-admission observer land, there is no app
 * socket. LAB builds (env.LAB === "1") expose a token-guarded admin surface.
 *
 * The same Worker runs the ESCROW service (env.SERVICE_KIND === "escrow", its own
 * deployment and service device): it follows the log to stay keyed and, as a
 * fallback, grants the current epoch key to approved account devices (replica
 * `key_grant_turn`: at once without an active hosted device, else 120 s after the
 * enrolment). It serves no content: no WebSocket, no client frames; LAB keeps only
 * the admin status and a wake. With no push from the log it polls on an alarm.
 * Note: the engine still rebuilds its local cache in the DO's SQLite (never served).
 */
import { DurableObject } from "cloudflare:workers";
import { encode, type CborValue } from "../../../packages/sdk/src/cbor.js";
import { Engine } from "./engine.js";
import { AlarmLifecycle } from "./alarm-lifecycle.ts";
import { attachmentSlots, ChunkBusy, type ChunkPermit } from "./chunk-slots.ts";
import { deploymentLog, pumpLog, PumpReport, SpareNonces, StaleAppendStore, type CallTimings } from "./log.js";
import { DENY_ADMISSION, DENY_CUSTODY, DENY_WRAPPER, type Admission, type Custody, type OpenKeys } from "./seams.js";
import { distinctServiceTokens, generateServiceDevice, serviceActivation, serviceCollection, serviceInitialization } from "./service-devices.js";
import { PitrCut, PitrWork } from "./pitr-cut.ts";
import { PitrActorRestriction } from "./pitr-actor.ts";
import { pitrFactory, type PitrFactorySettings } from "./pitr-factory.ts";
import { modeServiceRequest, modeReady, modeAck, modeUnavailable } from "./collection-mode.js";
import { generateDeviceKeys } from "./keygen.js";
import engineModule from "../hosted.wasm";
import { labCustody, labAuthorized } from "./lab.js";
import { labStubUnwrap } from "./custody-stub.js";
import { combinedCustody, cpCustody } from "./cp-custody.js";
import { ControlClient } from "./control.js";
import { isPermanentCustodyRefusal, withCustodyRetry } from "./custody-retry.ts";
import { ProductionCustody, deploymentRelease, productionParts, serviceDeviceWrapper, type FactoryEnv } from "./factory.ts";
import { devicePublicKeys, verifyHostedGenesis } from "./keygen.js";
import { resetIndex } from "./sql.js";
import { labHealth } from "./health.js";
import { locationHint, namedStub } from "./do-location.ts";
import { fetchAttachment } from "./object-reads.js";
import { deploymentObjectOrigins, type ObjectOriginPolicy } from "./object-origins.ts";
import { grantRecipients, hasGrantAppend, wakeCollectionTag, wakeLog } from "./wake-observe.ts";
import { INSTALL_RETRY_MAX_STEPS, INSTALL_WAKE_MS, installRetryMs } from "./install-retry.ts";
import { PIN_RESET_KEY, PinParked, isPinMismatch, pinLog, pinsDigest } from "./pin-reset.ts";
import { readyDiagnostic, type ReadyDiagnostic, type ReadyTrace } from "./ready-diagnostic.ts";
import { LiveAdmission, type AdmissionContext } from "./admission/live-admission.ts";
import { FrameReader, MAX_APP_BUFFERED, MAX_APP_SESSIONS, MAX_APP_SOCKETS, evidence, frameChunks, parsePrologue, uuidString } from "./app.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** Socket-independent hosted polling fallback; committed CP policy also wakes it. */
const REFRESH_MS = 30_000;
/** Both caught failures and unfinished opens back off (capped at 16 min).
 * Only consecutive unfinished opens on the same deployment can park the actor. */
const OPEN_BACKOFF_STEPS = 5;
const OPEN_FAILURES_KEY = "service-open-failures";
const OPEN_UNFINISHED_KEY = "service-open-unfinished";
const OPEN_PARK_AFTER = 3;
class OpenParked extends Error {}
const openRetryMs = (failures: number) =>
  REFRESH_MS * 2 ** Math.min(Math.max(0, Math.floor(failures)), OPEN_BACKOFF_STEPS) + Math.floor(Math.random() * 5_000);
/** The escrow learns of new enrolments at least this often (no push from the log). */
const ESCROW_POLL_MS = 60_000;
/** Idle back-off: each sync that learns nothing new doubles the polling interval
 * (hosted 30 s, escrow 60 s) up to this cap of an hour. Every idle actor polled the
 * log, and minted a log token, every 30-60 s; with hundreds of collections that held
 * the control plane busy. Any activity resets to the base interval: a client request
 * or open client socket, a CP activation, a local write, or a sync that moved
 * anything but head checks (a new remote head means reads). The log has no push
 * to hosted actors, so there is no notification to reset on. Erasure does not wait
 * for this poll: deleting a collection or account, or switching it to Private,
 * wakes the copy through a CP activation; the poll is only the backstop. */
const IDLE_POLL_CAP_MS = 60 * 60_000;
const IDLE_STREAK_KEY = "service-idle-streak";
const IDLE_SAME_LOOK_MS = 5_000;
/** Doublings that reach the cap from the smaller (hosted) base. */
const IDLE_MAX_STREAK = 7;
export const idlePollMs = (base: number, streak: number) =>
  Math.min(IDLE_POLL_CAP_MS, base * 2 ** Math.min(Math.max(0, Math.floor(streak)), IDLE_MAX_STREAK));
const INSTALL_RETRY_KEY = "service-install-retry";
/** Largest client frame accepted. */
const MAX_FRAME_BYTES = 1 << 20;

function uuidBytes(u: string): Uint8Array {
  return Uint8Array.from(u.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16)));
}

function openConfig(collection: string, k: OpenKeys, grantOnly = false): Uint8Array {
  const m = new Map<number, CborValue>([
    [0, uuidBytes(collection)],
    [1, uuidBytes(k.replicaId)],
    [2, uuidBytes(k.deviceId)],
    [3, k.roots],
    [4, k.signers.map(uuidBytes)],
    [5, k.signSk],
    [6, k.kemSk],
    // The escrow's emission profile: fallback key grants only (no rekey/content).
    ...(grantOnly ? [[7, true] as [number, CborValue]] : []),
    [8, k.policyPins],
    [9, k.originalGenesis],
    [10, k.genesisSha256],
  ]);
  return encode(m);
}

function pitrConfigured(env: Env): boolean {
  const p = env as Env & PitrFactorySettings & { PITR_PHASE?: R2Bucket };
  return p.PITR_BINDING !== undefined || p.PITR_MINIMUM_EPOCH !== undefined
    || p.PITR_ESCROW_SERVICE_TOKEN !== undefined || p.PITR_PHASE !== undefined;
}

const unconfiguredCustody = (error: unknown): boolean => error instanceof Error && error.message === "custody_not_configured";

/** A lasting custody verdict on an activation: an answer the CP records, not a 5xx. */
function verdictAnswer(error: unknown): Response {
  return Response.json({ error: (error as Error).message }, { status: 409, headers: { "cache-control": "no-store" } });
}

export class HostedCollection extends DurableObject<Env> {
  /** Temporary deny-only actor mode. Only removal through reviewed all-path
   * integration may open it; no request, R2 record or restored SQL flag can. */
  private readonly pitrClosed: boolean;
  private readonly pitrWork: PitrWork | null;
  private readonly pitrRestriction: PitrActorRestriction | null = null;
  private readonly pitrCut: PitrCut | null = null;
  private engine: Engine | null = null;
  private attachmentPermit: { engine: Engine; session: number; permit: ChunkPermit } | null = null;
  private attachmentWaiters = new Map<AbortController, { engine: Engine; session: number }>();
  private opening: Promise<Engine> | null = null;
  /** Trace belongs to this exact cached opening, never a last-request stage. */
  private openingTrace: ReadyTrace | null = null;
  private background: AlarmLifecycle | null = null;
  private get alarms(): AlarmLifecycle {
    return this.background ??= new AlarmLifecycle(this.ctx.storage);
  }
  private async requireBackground(): Promise<void> {
    if (this.pitrClosed) throw new Error("pitr_actor_closed");
    if (!await this.alarms.allowed()) throw new Error("hosted_alarm_inhibited");
  }
  /** Log session generation: bumped whenever the engine is reset or replaced, so a
   * reply that resolves afterwards is never fed to an engine. */
  private logGen = 0;
  /** Appends whose outcome arrived for a stale session: exact bytes, bounded by
   * credits reserved before sending, never evicted. */
  private staleAppends = new StaleAppendStore();
  /** The log's piggybacked nonces: memory only, so eviction costs one `GET /v1/nonce`. */
  private logNonces = new SpareNonces();
  private collection: string | null = null;
  private readonly objectOrigins: ObjectOriginPolicy;
  private custody: Custody;
  private admission: Admission;
  private lastRefresh = 0;
  /** Consecutive syncs that learned nothing new (persisted: survives eviction). */
  private idleStreak: number | null = null;
  /** Set while this actor has seen a running install. */
  private installRetry: { failures: number; done: number } | null = null;
  /** Activity since the last sync's back-off decision. */
  private activitySeen = false;
  /** When the last back-off decision was made (RAM). */
  private idleDecidedAt = 0;
  /** This open follows a pin-mismatch cache drop: check the rebuilt state. */
  private pinRebuild = false;
  /** The log fails the pins (see `pin-reset.ts`); nothing reopens in this isolate. */
  private pinParked = false;
  /** Phase timings of this wake's first open (LAB status only). */
  private timings: Record<string, unknown> | null = null;
  /** When this DO instance (wake) started. */
  private readonly wokeAt = Date.now();

  constructor(ctx: DurableObjectState, env: Env, requiredPitr = false) {
    super(ctx, env);
    this.pitrClosed = requiredPitr || pitrConfigured(env);
    this.pitrWork = this.pitrClosed ? new PitrWork(promise => ctx.waitUntil(promise)) : null;
    this.objectOrigins = deploymentObjectOrigins(env as Env & { OBJECT_STORAGE_ORIGINS?: string });
    const lab = env.LAB === "1";
    const e = env as unknown as {
      SERVICE_KIND?: string; CP_URL?: string; CP_INBOUND_TOKEN?: string; CP_ROOTS?: string;
      LAB_CUSTODY_WRAP_KEY?: string; LAB_HOSTED_CONFIG?: string;
    };
    this.escrow = e.SERVICE_KIND === "escrow";
    if (this.pitrClosed) {
      this.production = null;
      this.custody = DENY_CUSTODY;
      this.admission = DENY_ADMISSION;
      this.closePitrResources();
      try {
        const restriction = PitrActorRestriction.from(ctx, env, this.pitrWork!);
        const cut = restriction?.cut(() => this.closePitrResources()) ?? null;
        this.pitrRestriction = restriction;
        this.pitrCut = cut;
      } catch { /* Physical/configuration drift remains CLOSED. */ }
      return; // No fixture, release/KMS parts, CP client, keys or engine opening.
    }
    // LAB: the fixture's keys for its listed collections; for any other collection,
    // the control plane's service-device record opened with the custody stub.
    const release = deploymentRelease(env as unknown as FactoryEnv);
    const verifyOriginal = (collection: string, pins: Uint8Array, item: Uint8Array, hash: Uint8Array) =>
      verifyHostedGenesis(engineModule, collection, pins, item, hash);
    const cp = lab && release && e.CP_URL?.startsWith("https://") && e.CP_INBOUND_TOKEN && e.LAB_CUSTODY_WRAP_KEY
      ? cpCustody({ kind: this.escrow ? "escrow" : "hosted",
        control: new ControlClient({ url: e.CP_URL, token: e.CP_INBOUND_TOKEN, kind: this.escrow ? "escrow" : "hosted" }),
        roots: release.trustedRoots, policyPins: release.policyPins, verifyOriginal,
        unwrap: (kind, collection, device, envelope, signal) =>
          labStubUnwrap(e.LAB_CUSTODY_WRAP_KEY!, kind, collection, device, envelope, signal),
        derive: (secret) => devicePublicKeys(engineModule, secret) })
      : null;
    const inFixture = (collection: string) => {
      try {
        return (JSON.parse(e.LAB_HOSTED_CONFIG ?? "{}") as { collections?: string[] }).collections?.includes(collection) ?? false;
      } catch {
        return false;
      }
    };
    // Production: KMS custody when fully configured; otherwise LAB stub
    // custody on LAB builds; otherwise DENY.
    const parts = this.escrow ? null : productionParts(env as unknown as FactoryEnv);
    this.production = parts
      ? new ProductionCustody(parts, () => this.replicaId(), (secret) => devicePublicKeys(engineModule, secret), verifyOriginal, lab)
      : null;
    this.custody = this.production ?? (lab ? combinedCustody(labCustody(env, (secret) => devicePublicKeys(engineModule, secret), verifyOriginal), inFixture, cp) : DENY_CUSTODY);
    this.admission = DENY_ADMISSION;
  }

  private closePitrResources(): void {
    this.pitrWork?.close(); // RAM fence before callback/resource work.
    this.engineReset("pitr_close");
    this.logGen++;
    if (this.engine) this.releaseAttachment(this.engine);
    for (const reader of this.readers.values()) reader.wipe();
    this.readers.clear();
    this.live = null;
    this.engine = null;
    // Hibernated sockets and auto-replies must not bypass the entrypoint closure.
    this.ctx.setWebSocketAutoResponse();
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.close(1012, "pitr closed"); } catch { /* Already closed. */ }
    }
  }

  /** Live admission for app sessions (hosted with a Noise key), else null (deny). */
  private live: { engine: Engine; admission: LiveAdmission; device: string } | null = null;
  /** Frame reassembly per app Noise session (RAM only; gone with the wake). */
  private readers = new Map<number, FrameReader>();

  private async liveAdmission(engine: Engine, collection: string,
    app: { device: string; publicKeys: { signPk: Uint8Array; kemPk: Uint8Array; noisePk: Uint8Array }; roots: Uint8Array[] }) {
    const roots = await Promise.all(app.roots.map(async (pk) =>
      ({ id: uuidString(new Uint8Array(await crypto.subtle.digest("SHA-256", pk)).subarray(0, 16)), pk })));
    // The trusted synchronous bridge: the engine's own live observation each call.
    const source = {
      observe: () => evidence(engine.admission()),
      wake: () => engine.wakeInstance(),
      noiseMatches: (pk: Uint8Array) => engine.noiseMatches(pk),
      authorizeApp: (ctx: AdmissionContext) =>
        !!ctx.grant && !!ctx.clientPk && engine.grantOk(uuidBytes(ctx.grant), ctx.clientPk),
    };
    return { engine, admission: new LiveAdmission({ collection, device: app.device, ...app.publicKeys, roots }, source), device: app.device };
  }

  /** Final synchronous admission, immediately before an effect or output, bound to
   * the exact engine (wake) the caller is working with: after a reset, an older
   * engine's pending work never borrows the new engine's proof. */
  private admitted(engine: Engine, ctx: AdmissionContext): boolean {
    return !this.pitrClosed && !!this.live && this.live.engine === engine && this.engine === engine &&
      this.live.admission.recheck(ctx) === "allow";
  }

  /** The production KMS custody, when configured (closed on terminal events). */
  private readonly production: ProductionCustody | null;

  /** A replica ID for this DO, persisted so it is stable across wakes. */
  private async replicaId(): Promise<string> {
    const have = await this.ctx.storage.get<string>("hosted-replica-id");
    if (have && UUID.test(have)) return have;
    const id = crypto.randomUUID();
    await this.ctx.storage.put("hosted-replica-id", id);
    return id;
  }

  /** This deployment is the escrow: no content surface, polls the log. */
  private readonly escrow: boolean;

  /** Actual platform references, never caller IDs or persisted collection labels.
   * VOID physical mapping only: does not admit this namespace or grant H1. */
  private requirePhysicalCollection(collection: string): void {
    if (!this.ctx.id.equals(this.env.COLLECTIONS.idFromName(collection))) {
      throw new Error("physical_collection_mismatch");
    }
  }

  /** An engine teardown: the held log token goes with it (LAB also logs the site). */
  private engineReset(site: string): void {
    this.dropLogToken();
    if (this.env.LAB === "1") {
      try { console.info(JSON.stringify({ event: "hosted_engine_reset", site })); } catch { /* Logging is not authority. */ }
    }
  }

  /** Open (or return) the engine for this wake, rebuilt from the log. */
  private async ready(collection: string, diagnose?: (value: ReadyDiagnostic) => void): Promise<Engine> {
    const trace: ReadyTrace = { stage: "background_guard" };
    try { return await this.readyTraced(collection, trace); }
    catch (error) {
      diagnose?.(readyDiagnostic(trace.opening?.stage ?? trace.stage, error));
      throw error; // Preserve error/PinParked identity for all non-migration callers.
    }
  }

  private async readyTraced(collection: string, trace: ReadyTrace): Promise<Engine> {
    await this.requireBackground();
    trace.stage = "physical_collection_guard";
    this.requirePhysicalCollection(collection);
    trace.stage = "collection_guard";
    if (this.collection && this.collection !== collection) throw new Error("collection mismatch");
    if (this.pinParked) throw new PinParked();
    this.collection = collection;
    // Both service roles must reopen after eviction without an app socket.
    trace.stage = "service_collection_persist";
    await this.ctx.storage.put("service-collection", collection);
    trace.stage = "alarm_guard";
    if (!this.alarms.current) throw new Error("hosted_alarm_inhibited");
    if (this.engine) return this.engine;
    const openingTrace = this.openingTrace ??= { stage: "open_retry_read" };
    trace.opening = openingTrace;
    let openFailures: number | undefined;
    this.opening ??= (async () => {
      // Reserve once, inside the shared opener, before custody/network work.
      // Only the alarm actually installed here may be replaced on success.
      openingTrace.stage = "open_retry_read";
      const version = this.env.CF_VERSION_METADATA?.id ?? "";
      const record = await this.ctx.storage.get<{ version: string; count: number }>(OPEN_UNFINISHED_KEY);
      const unfinished = record?.version === version ? record.count : 0;
      if (unfinished >= OPEN_PARK_AFTER) {
        await this.ctx.storage.deleteAlarm();
        console.warn(JSON.stringify({ event: "hosted_open_parked", role: this.escrow ? "escrow" : "hosted", unfinished, version }));
        throw new OpenParked("hosted_open_parked");
      }
      const stored = await this.ctx.storage.get<unknown>(OPEN_FAILURES_KEY);
      openFailures = typeof stored === "number" && Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
      // An isolate kill skips catch/finally. Commit its reservation before it can do work.
      await this.ctx.storage.put(OPEN_UNFINISHED_KEY, { version, count: unfinished + 1 });
      await this.ctx.storage.sync();
      openingTrace.stage = "open_retry_schedule";
      const retry = await this.alarms.schedule(Date.now() + openRetryMs(openFailures + unfinished), () => !this.engine);
      openingTrace.stage = "alarm_guard";
      if (!this.alarms.current) throw new Error("hosted_alarm_inhibited");
      openingTrace.stage = "custody_open_sealer";
      // First open of this wake: phase timings for the LAB status (Workers clocks
      // advance only across I/O, so CPU-only phases can read 0 ms).
      const t0 = Date.now();
      const calls: CallTimings = new Map();
      const keys = await withCustodyRetry((signal) => this.custody.openSealer(collection, signal), this.custodyRetryOptions("open_sealer"));
      const tKeys = Date.now();
      let engine: Engine;
      let tWasm: number;
      let app: { device: string; publicKeys: NonNullable<typeof keys.publicKeys>; roots: Uint8Array[] } | null = null;
      let pinBytes: Uint8Array, pinMismatch = false;
      try {
        openingTrace.stage = "background_guard";
        await this.requireBackground();
        openingTrace.stage = "physical_collection_guard";
        this.requirePhysicalCollection(collection);
        // Public tuple marker, inside key zeroization's finally boundary.
        openingTrace.stage = "mode_device_persist";
        await this.ctx.storage.put("collection-mode-device", keys.deviceId);
        await this.requireBackground();
        this.requirePhysicalCollection(collection);
        openingTrace.stage = "engine_construct";
        pinBytes = new Uint8Array(keys.policyPins); // public; outlives the zeroize
        engine = new Engine(this.ctx.storage);
        tWasm = Date.now();
        openingTrace.stage = "engine_config";
        const config = openConfig(collection, keys, this.escrow);
        try {
          openingTrace.stage = "engine_open";
          engine.open(config);
        } catch (error) {
          // Only the exact pin refusal; every other open failure keeps the store.
          if (!isPinMismatch(error)) throw error;
          pinMismatch = true;
        }
        // App sessions (hosted only): the Noise static secret moves into the
        // engine's RAM for this wake; the JS copy is wiped with the rest.
        openingTrace.stage = "engine_noise_key";
        if (!this.escrow && keys.noiseSk && keys.publicKeys && engine.noiseKey(keys.noiseSk.slice())) {
          app = { device: keys.deviceId, publicKeys: keys.publicKeys, roots: keys.roots.map((r) => r.slice()) };
        }
      } finally {
        const previousStage = openingTrace.stage;
        openingTrace.stage = "custody_zeroize";
        keys.zeroize();
        openingTrace.stage = previousStage; // Successful cleanup must not mask the failed stage.
      }
      openingTrace.stage = "pin_digest";
      const pins = await pinsDigest(pinBytes);
      openingTrace.stage = "pin_marker_read";
      const pinMarker = await this.ctx.storage.get<unknown>(PIN_RESET_KEY);
      openingTrace.stage = "pin_mismatch";
      if (pinMismatch) return this.pinMismatch(collection, pins, pinMarker);
      this.pinRebuild = pinMarker === pins;
      openingTrace.stage = "live_admission";
      const live = app ? await this.liveAdmission(engine, collection, app) : null;
      openingTrace.stage = "background_guard";
      await this.requireBackground();
      this.live = live;
      const tOpen = Date.now();
      this.engine = engine;
      // The open queued a head fetch: it counts as a refresh.
      this.lastRefresh = Date.now();
      openingTrace.stage = "sync";
      const gen = this.logGen;
      const next = await this.sync(engine, calls);
      openingTrace.stage = "pin_parked_guard";
      if (this.pinParked) throw new PinParked();
      openingTrace.stage = "timing_snapshot";
      const tDone = Date.now();
      const per = Object.fromEntries([...calls].map(([m, v]) => [m, v]));
      this.timings = {
        key_setup_ms: tKeys - t0,
        wasm_init_ms: tWasm - tKeys,
        engine_open_ms: tOpen - tWasm,
        head_fetch_ms: calls.get("head")?.firstMs ?? null,
        rebuild_ms: tDone - tOpen,
        total_ms: tDone - t0,
        serving: engine.serving(),
        log_calls: per,
      };
      if (this.env.LAB === "1") {
        // LAB: one line per first open, phase durations only (no ids or content).
        try { console.info(JSON.stringify({ event: "hosted_first_open", role: this.escrow ? "escrow" : "hosted", ...this.timings })); } catch { /* Logging is not authority. */ }
      }
      openingTrace.stage = "engine_reset";
      await this.checkCache(engine, true);
      // All open checks succeeded. Until here, a post-sync failure must still
      // have the earlier retry. Never replace a different pending wake.
      if (next !== undefined) {
        openingTrace.stage = "open_retry_schedule";
        await this.alarms.schedule(next, () => !this.pitrClosed && this.alarms.current && this.logGen === gen && this.engine === engine, retry ?? undefined);
      }
      openingTrace.stage = "open_failure_clear";
      if (openFailures) await this.ctx.storage.delete(OPEN_FAILURES_KEY);
      await this.ctx.storage.delete(OPEN_UNFINISHED_KEY);
      return engine;
    })().catch(async (error: unknown) => {
      if (openFailures === undefined) throw error; // No attempt reserved (including parked opens).
      if (this.lastingRefusal(error)) {
        try { await this.retireForVerdict(error); } catch (failure) { error = failure; }
        if (this.lastingRefusal(error)) throw error;
      }
      await this.ctx.storage.delete(OPEN_UNFINISHED_KEY);
      try { await this.ctx.storage.put(OPEN_FAILURES_KEY, openFailures + 1); } catch { /* the retry alarm is already set */ }
      throw error;
    }).finally(() => {
      this.opening = null;
      this.openingTrace = null;
    });
    return this.opening;
  }

  /** The cached store fails the pins (`pin-reset.ts`). The first time for these
   * pins, drop the `st_*` cache (the migration ledger stays) and retry soon, so
   * the next open rebuilds from the log; a rebuild that fails again backs off as
   * any failed open does. The same refusal after that drop means the store was
   * rebuilt from the log under these pins: park. */
  private async pinMismatch(collection: string, pins: string, marker: unknown): Promise<never> {
    if (marker === pins) return this.parkPins(collection);
    if (!this.alarms.current) throw new Error("hosted_alarm_inhibited");
    resetIndex(this.ctx.storage);
    await this.ctx.storage.put(PIN_RESET_KEY, pins);
    pinLog(await wakeCollectionTag(collection), this.escrow ? "escrow" : "hosted", "pin_reset");
    await this.alarms.schedule(Date.now() + REFRESH_MS, () => !this.engine);
    throw new Error("hosted cache reset after pin mismatch; retry");
  }

  private async checkCache(engine: Engine, opening: boolean): Promise<void> {
    if (this.engine !== engine) return;
    const recovery = engine.cacheRecovery();
    if (!recovery) return;
    this.releaseAttachment(engine);
    this.engineReset(`cache_${recovery}`);
    const generation = ++this.logGen;
    this.engine = null;
    this.live = null;
    for (const reader of this.readers.values()) reader.wipe();
    this.readers.clear();
    const current = () => !this.pitrClosed && this.logGen === generation && !this.engine;
    try {
      if (recovery === "reopen") throw new Error("hosted cache reopen required");
      resetIndex(this.ctx.storage);
    } catch (error) {
      if (!opening) await this.alarms.schedule(Date.now() + openRetryMs(0), current);
      throw error;
    }
    await this.alarms.schedule(Date.now() + REFRESH_MS, current);
    throw new Error("hosted cache reset; retry");
  }

  /** No alarm, no engine; a later wake in a new isolate re-evaluates the open. */
  private async parkPins(collection: string): Promise<never> {
    this.pinParked = true;
    this.pinRebuild = false;
    if (this.engine) {
      this.releaseAttachment(this.engine);
      this.engineReset("pin_park");
      this.logGen++;
      this.engine = null;
      this.live = null;
      for (const r of this.readers.values()) r.wipe();
      this.readers.clear();
    }
    await this.ctx.storage.deleteAlarm();
    pinLog(await wakeCollectionTag(collection), this.escrow ? "escrow" : "hosted", "pin_parked");
    throw new PinParked();
  }

  /** A refusal no timer can change. An escrow deployment without custody is one.
   * A hosted one is misconfigured, so its objects keep retrying until it is fixed. */
  private lastingRefusal(error: unknown): boolean {
    return isPermanentCustodyRefusal(error) || (this.escrow && unconfiguredCustody(error));
  }

  /** Custody gave a lasting verdict (the KMS does not serve the collection, or the
   * CP holds no current service device: deleted / left sync). Stop being a
   * background actor for it: drop the live engine and its sessions, drop the
   * rebuildable `st_*` cache (the migration ledger stays), forget the open
   * backoff and cancel the alarm, so no timer wakes this collection again. Only a
   * new CP activation or app connection re-evaluates custody; a transient
   * refusal never reaches here and keeps its backed-off retry alarm. An escrow
   * without custody keeps its `st_*` tables: that refusal is this deployment's
   * setting, not a verdict on the collection. */
  private async retireForVerdict(error?: unknown): Promise<void> {
    if (this.engine) {
      this.releaseAttachment(this.engine);
      this.engineReset("custody_verdict");
      this.logGen++;
      this.engine = null;
      this.live = null;
      for (const r of this.readers.values()) r.wipe();
      this.readers.clear();
    }
    if (!unconfiguredCustody(error)) resetIndex(this.ctx.storage);
    await this.ctx.storage.delete(OPEN_FAILURES_KEY);
    await this.ctx.storage.delete(OPEN_UNFINISHED_KEY);
    await this.ctx.storage.deleteAlarm();
    if (this.env.LAB === "1") {
      try { console.info(JSON.stringify({ event: "hosted_custody_verdict_retired", role: this.escrow ? "escrow" : "hosted" })); } catch { /* Logging is not authority. */ }
    }
  }

  private async retireModeDevice(collection: string, expectedDevice: string): Promise<boolean> {
    const storage = this.ctx.storage;
    const matchesDevice = async () => {
      this.requirePhysicalCollection(collection);
      const device = await storage.get<string>("collection-mode-device");
      return (!device || device === expectedDevice) && (!this.live || this.live.device === expectedDevice);
    };
    if (this.opening && !await matchesDevice()) return false;
    const opening = this.opening;
    let resumeAt: number | null = null;
    if (opening) {
      // Park before joining: a killed opener cannot acknowledge retirement.
      resumeAt = await storage.getAlarm() ?? Date.now() + REFRESH_MS;
      await storage.put(OPEN_UNFINISHED_KEY, { version: this.env.CF_VERSION_METADATA?.id ?? "", count: OPEN_PARK_AFTER });
      await storage.deleteAlarm();
      await storage.sync();
      try { await opening; } catch (error) {
        if (error instanceof OpenParked || this.lastingRefusal(error)) resumeAt = null;
      }
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (this.opening) return false;
        if (await matchesDevice()) {
          await this.retireForVerdict();
          return true;
        }
        if (resumeAt === null || this.pinParked) return false;
        // A completed retirement clears both open records and drops the engine.
        if (this.engine || (await storage.get([OPEN_UNFINISHED_KEY, OPEN_FAILURES_KEY])).size > 0) {
          if (await storage.getAlarm() === null) await this.alarms.schedule(resumeAt, () => this.alarms.current);
          await storage.delete(OPEN_UNFINISHED_KEY);
        }
        return false;
      } catch { return false; }
    });
  }

  /** After a pin-mismatch drop: park as soon as the state applied from the log
   * fails the pins; forget the drop once the rebuild reaches the head. */
  private async checkPinRebuild(engine: Engine): Promise<boolean> {
    if (!this.pinRebuild || !this.collection) return true;
    const state = engine.pinState();
    if (state === "inconsistent") {
      try { await this.parkPins(this.collection); } catch (error) { if (!(error instanceof PinParked)) throw error; }
      return false;
    }
    if (state === "rebuilt") {
      this.pinRebuild = false;
      await this.ctx.storage.delete(PIN_RESET_KEY);
      pinLog(await wakeCollectionTag(this.collection), this.escrow ? "escrow" : "hosted", "pin_rebuilt");
    }
    return true;
  }

  /** The log: the `LOG` service binding, or (`LOG_URL`) its public https origin
   * when the log Worker lives in another account. */
  private log(): Fetcher {
    return deploymentLog(this.env as unknown as { LOG_URL?: string; LOG?: Fetcher });
  }

  private token = () => withCustodyRetry((signal) => this.custody.logToken(this.collection!, signal), this.custodyRetryOptions("log_token"));

  /** Drop the custody's held log token: the next `token()` asks the CP. */
  private dropLogToken(): void {
    try { if (this.collection) this.custody?.invalidateLogToken?.(this.collection); } catch { /* Custody errors stay inside custody. */ }
  }

  /** Activity: the next back-off decision keeps (or returns to) the base interval. */
  private noteActivity(): void {
    this.activitySeen = true;
  }

  /** An open socket accepted in this wake (app session or LAB host). */
  private clientOpen(): boolean {
    return this.ctx.getWebSockets().some((ws) => {
      if (ws.readyState !== 1) return false;
      return (ws.deserializeAttachment() as { wake?: string } | null)?.wake === this.wakeId;
    });
  }

  /** The next poll after a sync: the base interval after activity, doubling per
   * consecutive idle sync up to the cap. The streak is persisted only when it
   * changes, so an evicted idle actor keeps backing off. */
  private async idlePoll(active: boolean, current: () => boolean): Promise<number> {
    const base = this.escrow ? ESCROW_POLL_MS : REFRESH_MS;
    let prior = this.idleStreak;
    if (prior == null) {
      try { prior = Math.max(0, Math.min(IDLE_MAX_STREAK, Math.floor(Number(await this.ctx.storage.get<number>(IDLE_STREAK_KEY) ?? 0)) || 0)); }
      catch { prior = 0; }
    }
    // Syncs moments apart (a cold open's sync, then the alarm's or activation's)
    // are one look at the log: only the first can lengthen the interval.
    const now = Date.now();
    const next = active ? 0 : now - (this.idleDecidedAt ?? 0) < IDLE_SAME_LOOK_MS ? prior : Math.min(prior + 1, IDLE_MAX_STREAK);
    this.idleDecidedAt = now;
    this.idleStreak = next;
    if (next !== prior && current()) {
      try { await (next === 0 ? this.ctx.storage.delete(IDLE_STREAK_KEY) : this.ctx.storage.put(IDLE_STREAK_KEY, next)); } catch { /* RAM still backs off. */ }
      if (this.env.LAB === "1") {
        try { console.info(JSON.stringify({ event: "hosted_idle_poll", role: this.escrow ? "escrow" : "hosted", streak: next, poll_ms: idlePollMs(base, next) })); } catch { /* Logging is not authority. */ }
      }
    }
    return idlePollMs(base, next);
  }

  /** Delay to the next wake of a running install; null when none is running. */
  private async installWake(install: { done: number; total: number } | null, failed: boolean, current: () => boolean): Promise<number | null> {
    let prior = this.installRetry;
    if (!install) {
      this.installRetry = null;
      if (prior?.failures && current()) try { await this.ctx.storage.delete(INSTALL_RETRY_KEY); } catch { /* Clears at the next pass. */ }
      return null;
    }
    if (!prior) {
      let stored: { failures?: unknown; done?: unknown } | undefined;
      try { stored = await this.ctx.storage.get<{ failures: number; done: number }>(INSTALL_RETRY_KEY); } catch { /* Start over. */ }
      const { failures, done } = stored ?? {};
      prior = Number.isSafeInteger(failures) && Number.isSafeInteger(done) ? { failures: failures as number, done: done as number } : { failures: 0, done: 0 };
    }
    const passed = install.done > prior.done;
    const failures = failed ? Math.min((passed ? 0 : prior.failures) + 1, INSTALL_RETRY_MAX_STEPS + 1) : passed ? 0 : prior.failures;
    const next = { failures, done: failures ? Math.max(prior.done, failed ? install.done : 0) : 0 };
    this.installRetry = next;
    if ((next.failures !== prior.failures || next.done !== prior.done) && current()) {
      try { await (next.failures ? this.ctx.storage.put(INSTALL_RETRY_KEY, next) : this.ctx.storage.delete(INSTALL_RETRY_KEY)); } catch { /* RAM still backs off this wake. */ }
    }
    return failed ? installRetryMs(failures) : INSTALL_WAKE_MS;
  }

  /** LAB diagnosis only: each transient custody refusal a fetch retried. */
  private custodyRetryOptions(fetch: "open_sealer" | "log_token") {
    return this.env.LAB === "1" ? { onRetry: (facts: { attempt: number; code: string; call: string | null; name: string | null; message: string | null }) =>
      console.info(JSON.stringify({ event: "custody_retry", fetch, ...facts })) } : {};
  }

  /** Move log traffic until quiet, deliver output, schedule the next wakeup. */
  private async sync(engine: Engine, openingTimings?: CallTimings): Promise<number | undefined> {
    if (this.pitrClosed) { this.closePitrResources(); return; }
    const gen = this.logGen;
    const current = () => !this.pitrClosed && this.alarms.current && this.logGen === gen && this.engine === engine;
    if (!await this.alarms.allowed() || !current()) return;
    const tag = this.env.LAB === "1" && this.collection ? await wakeCollectionTag(this.collection) : null;
    if (!current()) return;
    const applied = engine.appliedHead();
    const report = new PumpReport();
    let delivered = 0;
    await pumpLog(this.log(), engine, this.token, current, this.staleAppends, 64, openingTimings, tag ? (call) => {
      if (current() && hasGrantAppend(call.frame)) wakeLog(tag, this.escrow ? "escrow" : "hosted", "grant_emitted", undefined, grantRecipients(call.frame));
    } : undefined, tag ? (call, observation) => {
      if (current() && hasGrantAppend(call.frame)) wakeLog(tag, this.escrow ? "escrow" : "hosted", "grant_append_outcome", observation);
    } : undefined, { tokenRefused: () => this.dropLogToken(), report, objectOrigins: this.objectOrigins, nonces: this.logNonces });
    if (!current() || !await this.checkPinRebuild(engine) || !current()) return;
    if (!openingTimings) {
      await this.checkCache(engine, false);
      if (!current()) return;
    }
    this.pruneAttachment();
    delivered += this.deliver(engine); // read_file response precedes object/network waits
    if (!this.escrow) {
      // At most manifest + one complete chunk. The engine refuses a second
      // ciphertext slot while its owned plaintext chunk still needs draining.
      for (let i = 0; i < 2 && current(); i++) {
        const read = engine.attachmentObject();
        if (!read) break;
        delivered++;
        const permitted = () => current() && this.attachmentPermit?.engine === engine &&
          this.attachmentPermit.session === read.session && this.attachmentPermit.permit.active &&
          this.attachmentAdmitted(engine, read.session);
        try {
          if (!permitted() || !engine.attachmentAllowed(read.ticket)) throw new Error("read denied");
          const token = await this.token();
          if (!permitted() || !engine.attachmentAllowed(read.ticket)) throw new Error("read denied");
          await fetchAttachment(this.log(), engine, token, read, permitted, this.objectOrigins);
          if (permitted()) this.attachmentPermit?.permit.touch();
        } catch { engine.attachmentFailed(read.ticket); }
        finally { read.frame.fill(0); }
        if (!current()) return;
        delivered += this.deliver(engine);
      }
    }
    if (!current()) return;
    this.pruneAttachment();
    const progressed = engine.appliedHead() !== applied;
    // Cold recovery replays control data on every eviction. Only a completed,
    // unchanged native rebuild can discount successful reads; writes, partial
    // rebuilds, failures and actual new log progress still reset the streak.
    const replayOnly = report.reads > 0 && report.work === report.reads && report.failed === 0 && !progressed && engine.serving();
    // LAB only (cost): answered log calls that moved nothing are not activity. An
    // upload the log answers with an error (quota) or a stalled replica's reads
    // repeat on every wake and would otherwise hold the actor at the base poll
    // forever. Transport failures still retry at the base rate.
    const lab = this.env.LAB === "1";
    const pumped = lab ? report.failed > 0 : !report.quiet && !replayOnly;
    const active = this.activitySeen || pumped || progressed || delivered > 0 || this.clientOpen();
    this.activitySeen = false;
    const pollMs = await this.idlePoll(active, current);
    if (!current()) return;
    const install = engine.installStatus();
    // Counts only, in every environment: the one sign of an install in production.
    if (install) try { console.info(JSON.stringify({ event: "hosted_install_progress", role: this.escrow ? "escrow" : "hosted", ...install })); } catch { /* Logging is not authority. */ }
    // No count of the collection's text, and no identifiers.
    if (engine.snapshotDeclined()) try { console.info(JSON.stringify({ event: "hosted_snapshot_declined", role: this.escrow ? "escrow" : "hosted" })); } catch { /* Logging is not authority. */ }
    const installMs = await this.installWake(install, report.failed > 0, current);
    if (!current()) return;
    const poll = Date.now() + (installMs ?? pollMs);
    // LAB only (cost): an idle replica that is not serving (apply-stalled) waits
    // for the idle poll, not its in-memory stall probe, which restarts at 1 s
    // after every eviction and so never backs off.
    const probe = engine.nextWakeup(lab && !active && installMs == null && !engine.serving());
    // Preserve earlier deadlines; inhibited or stale storage continuations must
    // not schedule another wake. This local fence is not deletion currentness.
    const at = Math.min(probe ?? poll, poll);
    // During open, only the opener installs the poll, after its final native checks.
    if (!openingTimings) await this.alarms.schedule(at, current);
    return at;
  }

  private releaseAttachment(engine: Engine, session?: number): void {
    const held = this.attachmentPermit;
    if (held?.engine === engine && (session === undefined || held.session === session)) {
      held.permit.release();
      this.attachmentPermit = null;
    }
    for (const [controller, waiter] of this.attachmentWaiters ?? []) {
      if (waiter.engine === engine && (session === undefined || waiter.session === session)) {
        controller.abort();
        this.attachmentWaiters.delete(controller);
      }
    }
  }
  private pruneAttachment(): void {
    const held = this.attachmentPermit;
    if (!held) return;
    const expired = held.engine !== this.engine || !held.permit.active;
    if (expired) {
      held.engine.close(held.session); // wipes held fixed-region plaintext
      this.releaseAttachment(held.engine, held.session);
    } else if (!held.engine.attachmentActive(held.session)) {
      // EOF retires only this permit, not queued calls on the still-live session.
      held.permit.release();
      this.attachmentPermit = null;
    }
  }
  /** READ/folder/policy preflight precedes bounded queueing. Resource permission
   * never substitutes for current engine/session/socket admission after await. */
  private async attachmentFrame(engine: Engine, session: number, frame: Uint8Array): Promise<void> {
    this.pruneAttachment();
    const gen = this.logGen;
    const admitted = () => this.engine === engine && this.logGen === gen && this.attachmentAdmitted(engine, session);
    if (!admitted()) { engine.close(session); this.releaseAttachment(engine, session); return; }
    if (!engine.attachmentCallRequiresSlot(session, frame)) {
      engine.frame(session, frame);
      this.attachmentPermit?.permit.touch();
      this.pruneAttachment();
      return;
    }
    const controller = new AbortController();
    this.attachmentWaiters.set(controller, { engine, session });
    let permit: ChunkPermit;
    try { permit = await attachmentSlots.acquire(controller.signal); }
    catch (error) {
      if (!(error instanceof ChunkBusy)) throw error;
      if (admitted()) engine.attachmentCallBusy(session, frame); // native READ recheck
      else engine.close(session);
      return;
    } finally { this.attachmentWaiters.delete(controller); }
    if (!permit.active || !admitted()) { permit.release(); engine.close(session); return; }
    this.attachmentPermit = { engine, session, permit };
    // Original frame handler rechecks READ and creates the actual pin now.
    engine.frame(session, frame);
    this.pruneAttachment();
  }

  private attachmentAdmitted(engine: Engine, session: number): boolean {
    if (this.pitrClosed) return false;
    const ws = this.ctx.getWebSockets().find((ws) => {
      const a = ws.deserializeAttachment() as AppAttachment | null;
      return ws.readyState === 1 && a?.wake === this.wakeId && a.session === session;
    });
    if (!ws) return false;
    const a = ws.deserializeAttachment() as AppAttachment;
    if (!a.app) return this.env.LAB === "1"; // existing authenticated LAB-only admin socket
    return !!a.noise && this.admitted(engine, { collection: this.collection!, op: "call", grant: a.grant, clientPk: fromHex(a.client ?? "") });
  }

  /** Delivers the engine's output; returns how many outputs it had. */
  private deliver(engine: Engine): number {
    if (this.pitrClosed) {
      this.closePitrResources();
      const outputs = engine.poll();
      for (const output of outputs) output.frame?.fill(0);
      return outputs.length;
    }
    const bySession = new Map<number, WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { session?: number; wake?: string } | null;
      if (a?.session !== undefined && a.wake === this.wakeId) bySession.set(a.session, ws);
    }
    const outputs = engine.poll();
    for (const o of outputs) {
      // Every output frame is wiped on every path: no socket, denied, sealed or sent.
      try {
        const ws = bySession.get(o.session);
        if (!ws) continue;
        const a = ws.deserializeAttachment() as AppAttachment;
        if (o.frame === null) {
          if (a.noise) engine.noiseDrop(a.noise);
          ws.close(1000, "closed");
        } else if (a.noise) {
          // App output: admitted again right before it leaves, with no await between.
          if (!this.admitted(engine, { collection: this.collection!, op: "output", grant: a.grant, clientPk: fromHex(a.client ?? "") })) {
            this.endApp(engine, ws, a, 1008, "denied");
            continue;
          }
          const chunks = frameChunks(o.frame);
          try {
            for (const chunk of chunks) {
              const c = engine.noiseSeal(a.noise, chunk);
              if (!c) {
                this.endApp(engine, ws, a, 1011, "session");
                break;
              }
              ws.send(c);
            }
          } finally {
            for (const chunk of chunks) chunk.fill(0);
          }
        } else {
          ws.send(o.frame);
        }
      } finally {
        o.frame?.fill(0);
      }
    }
    return outputs.length;
  }

  /** Distinguishes sockets accepted in this wake from older ones (RAM state gone). */
  private readonly wakeId = crypto.randomUUID();

  /** A Wasm trap has no panic text to report: one line, with no identifiers. */
  private noteTrap(error: unknown): void {
    if (!(error instanceof WebAssembly.RuntimeError)) return;
    try { console.info(JSON.stringify({ event: "hosted_wasm_trap", role: this.escrow ? "escrow" : "hosted" })); } catch { /* Logging is not authority. */ }
  }

  async alarm(): Promise<void> {
    try { await this.runAlarm(); }
    catch (error) { this.noteTrap(error); throw error; }
  }

  private async runAlarm(): Promise<void> {
    if (this.pitrClosed) {
      this.closePitrResources();
      await this.pitrWork!.trackClosed(() => this.ctx.storage.deleteAlarm());
      return; // No stored collection lookup, custody, tick, refresh or reschedule.
    }
    if (!await this.alarms.allowed()) {
      await this.alarms.inhibit();
      return;
    }
    const cold = !this.engine;
    if (cold) {
      // Keep the old escrow key readable for existing enrolled DOs.
      const collection = await this.ctx.storage.get<string>("service-collection")
        ?? (this.escrow ? await this.ctx.storage.get<string>("escrow-collection") : undefined);
      if (collection && UUID.test(collection)) {
        // Parking and retirement both cancel the alarm. Acknowledge delivery so
        // the platform does not retry it either.
        try { await this.ready(collection); } catch (error) { if (error instanceof OpenParked || error instanceof PinParked || this.lastingRefusal(error)) return; throw error; }
      }
    }
    if (!await this.alarms.allowed() || !this.engine || !this.collection) return;
    const engine = this.engine;
    engine.tick(Date.now(), cold);
    if (this.escrow || Date.now() - this.lastRefresh >= REFRESH_MS) {
      this.lastRefresh = Date.now();
      engine.refresh();
    }
    try { await this.sync(engine); }
    catch (error) {
      // A warm engine learns of deletion through its next log token.
      if (!this.lastingRefusal(error)) throw error;
      await this.retireForVerdict(error);
      return;
    }
  }

  async fetch(request: Request): Promise<Response> {
    try { return await this.respond(request); }
    catch (error) { if (error instanceof OpenParked) return modeUnavailable(); this.noteTrap(error); throw error; }
  }

  private async respond(request: Request): Promise<Response> {
    if (this.pitrClosed) {
      this.closePitrResources();
      const url = new URL(request.url);
      if (this.pitrRestriction && request.method === "POST" && url.pathname === "/v1/hosted/activate" && !request.signal.aborted) {
        // Actual CLOSED activation callback, not a permit or a custody opening.
        // Track through finally; close/abort never stands in for settlement.
        let work: ReturnType<PitrWork["beginClosed"]> | undefined;
        const generation = this.logGen;
        try {
          this.pitrCut!.assertRestrictionIdle();
          work = this.pitrWork!.beginClosed();
          work.check();
          await this.pitrRestriction.assertSeedCurrent(url.searchParams.get("collection") ?? "", work.signal);
          work.check();
          if (request.signal.aborted || generation !== this.logGen) throw new Error("pitr_actor_closed");
        } catch { /* Missing original-principal/current-CP admission stays CLOSED. */ }
        finally { work?.finish(); }
      }
      return new Response("unavailable", { status: 503, headers: { "cache-control": "no-store" } });
    }
    const url = new URL(request.url);
    const collection = url.searchParams.get("collection") ?? "";
    if (!UUID.test(collection)) return new Response("bad collection", { status: 400 });
    if (url.pathname === "/v1/hosted/collection-mode/ready" || url.pathname === "/v1/hosted/collection-mode/retire") {
      const input = await modeServiceRequest(request, (this.env as Env & { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) {
        if (this.env.LAB === "1" && input.status === 503) console.info(JSON.stringify({ event: "collection_mode_not_ready", reason: "invalid_actor_request",
          token_configured: !!(this.env as Env & { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN }));
        return input;
      }
      if (input.collection !== collection) {
        if (this.env.LAB === "1") console.info(JSON.stringify({ event: "collection_mode_not_ready", reason: "actor_collection_mismatch" }));
        return modeUnavailable();
      }
      if (url.pathname.endsWith("/retire")) {
        return await this.retireModeDevice(collection, input.device) ? modeAck(input) : modeUnavailable();
      }
      let diagnostic: ReadyDiagnostic | undefined;
      const refuse = (reason: string, facts: Record<string, unknown> = {}) => {
        if (this.env.LAB === "1") console.info(JSON.stringify({ event: "collection_mode_not_ready",
          role: this.escrow ? "escrow" : "hosted", reason, ...facts }));
        return modeUnavailable();
      };
      try {
        const engine = await this.ready(collection, value => { diagnostic = value; });
        const generation = this.logGen;
        // CP enrolment activation can open this actor before the owner's grants
        // arrive. A warm cached open is not a fresh readiness observation.
        engine.refresh();
        await this.sync(engine);
        if (this.engine !== engine) return refuse("engine_changed");
        if (this.logGen !== generation) return refuse("generation_changed");
        if (this.opening) return refuse("opening");
        if (this.collection !== collection) return refuse("collection_changed");
        if (!modeReady(engine.modeServiceReady(),input)) return refuse("native_not_ready");
        return modeAck(input);
      } catch (error) { return refuse("exception", { diagnostic: diagnostic ?? readyDiagnostic("unknown", error) }); }
    }
    if (url.pathname === "/v1/hosted/initialize") {
      if (this.escrow) return new Response("not found", { status: 404 });
      const input = await serviceInitialization(request, (this.env as Env & { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) return input;
      if (input.collection !== collection) return new Response("bad collection", { status: 400 });
      this.noteActivity();
      const headers = { "cache-control": "no-store" };
      const pending = () => Response.json({ error: "initialization_not_confirmed" }, { status: 503, headers });
      try {
        const engine = await this.ready(collection);
        const generation = this.logGen;
        const current = () => this.engine === engine && this.logGen === generation && !request.signal.aborted;
        engine.requestHead();
        await this.sync(engine);
        if (!current()) return pending();
        let status = engine.initializeCollection(input.request_id, input.timezone, true);
        if (status === 0) {
          await this.sync(engine);
          if (!current()) return pending();
          status = engine.initializeCollection(input.request_id, input.timezone, false);
        }
        if (status === 1) return Response.json({ initialized: true, collection, request_id: input.request_id }, { headers });
        if (status === 2) return Response.json({ error: "initialization_refused" }, { status: 409, headers });
        return pending();
      } catch (error) {
        if (this.lastingRefusal(error)) {
          await this.retireForVerdict(error);
          return verdictAnswer(error);
        }
        return pending();
      }
    }
    if (url.pathname === "/v1/hosted/activate") {
      const approved = await serviceCollection(request, (this.env as unknown as { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN);
      if (approved instanceof Response) return approved;
      if (approved !== collection) return new Response("bad collection", { status: 400 });
      const tag = this.env.LAB === "1" ? await wakeCollectionTag(collection) : null;
      if (tag) wakeLog(tag, this.escrow ? "escrow" : "hosted", "wake_received");
      // Every committed policy batch (enrolment, removal, rekey) activates: mint a
      // fresh token against current eligibility, and poll at the base rate again.
      if (this.collection === collection) this.dropLogToken();
      this.noteActivity();
      let engine: Engine;
      try { engine = await this.ready(collection); }
      catch (error) {
        // A lasting verdict (deleted, left sync, not this deployment's) is an
        // answer, not a failure: ready() already retired the actor. The CP keeps
        // the batch pending and retries on its own backoff.
        if (this.lastingRefusal(error)) return verdictAnswer(error);
        throw error;
      }
      const generation = this.logGen;
      engine.refresh();
      try { await this.sync(engine); }
      catch (error) {
        // A warm engine learns of the verdict through its fresh log token (the
        // activation dropped the held one): retire as the alarm path does, and
        // give the CP the same definite answer as a cold open.
        if (!this.lastingRefusal(error)) throw error;
        await this.retireForVerdict(error);
        return verdictAnswer(error);
      }
      if (tag && this.engine === engine && this.logGen === generation) wakeLog(tag, this.escrow ? "escrow" : "hosted", "activation_complete");
      return Response.json({ activated: true }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname.endsWith("/app") && !this.escrow && request.headers.get("upgrade") === "websocket") {
      // App sessions: Noise authenticates; live admission decides each step.
      const engine = await this.ready(collection);
      if (!this.live) return new Response("not available", { status: 503 });
      this.noteActivity();
      // A backed-off actor may not have looked at the log for minutes: fetch the
      // head now, ahead of the session's first sync, so the client sees it.
      if (Date.now() - this.lastRefresh >= REFRESH_MS) {
        this.lastRefresh = Date.now();
        engine.refresh();
      }
      // Bounded ingress: at the socket cap, the oldest socket without a session
      // makes room. Sessions stay below the cap (MAX_APP_SESSIONS, checked at
      // hello), so sockets that never authenticate cannot hold out one that does.
      const apps = this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as AppAttachment | null)?.app);
      if (apps.length >= MAX_APP_SOCKETS) this.evictUnauthenticated(engine, apps);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ wake: this.wakeId, app: true, opened: Date.now() } satisfies AppAttachment);
      void engine;
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (this.env.LAB !== "1" || !labAuthorized(this.env, request)) return new Response("not found", { status: 404 });
    // ---- LAB admin surface: host session over a plaintext WebSocket ----
    const engine = await this.ready(collection);
    if (url.pathname.endsWith("/status")) {
      return Response.json({ serving: engine.serving(), wake: { id: this.wakeId, age_ms: Date.now() - this.wokeAt, first_open: this.timings }, stale_appends: this.staleAppends.count });
    }
    if (this.escrow) {
      // Escrow: follow the log now (and keep polling); never a content surface.
      if (url.pathname.endsWith("/wake") && request.method === "POST") {
        engine.refresh();
        await this.sync(engine);
        return Response.json({ keyed: engine.serving(), next_wakeup: engine.nextWakeup() });
      }
      return new Response("not found", { status: 404 });
    }
    if (request.headers.get("upgrade") === "websocket") {
      if (!engine.serving()) return new Response("rebuilding", { status: 503 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ wake: this.wakeId });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  /** Counts only, in every environment: a refusal otherwise leaves no production trace. */
  private noteRefused(engine: Engine): void {
    try { console.info(JSON.stringify({ event: "hosted_session_refused", role: this.escrow ? "escrow" : "hosted", serving: engine.serving(), installing: engine.installStatus() !== null })); } catch { /* Logging is not authority. */ }
  }

  /** App sockets of this wake that completed hello. */
  private appSessions(): number {
    return this.ctx.getWebSockets().filter((w) => {
      const a = w.deserializeAttachment() as AppAttachment | null;
      return !!a?.app && a.wake === this.wakeId && a.session !== undefined;
    }).length;
  }

  /** Close the oldest app socket that holds no session in this wake. */
  private evictUnauthenticated(engine: Engine, apps: WebSocket[]): void {
    let oldest: { ws: WebSocket; a: AppAttachment } | null = null;
    for (const ws of apps) {
      const a = ws.deserializeAttachment() as AppAttachment;
      if (a.wake === this.wakeId && a.session !== undefined) continue;
      if (!oldest || a.opened! < oldest.a.opened!) oldest = { ws, a };
    }
    if (!oldest) throw new Error("hosted_app_sockets_exceed_sessions");
    // An earlier wake's handles are not this engine's: close that socket only.
    if (oldest.a.wake === this.wakeId) this.endApp(engine, oldest.ws, oldest.a, 1013, "busy");
    else oldest.ws.close(1012, "rehandshake");
  }

  /** End an app session: Noise state, reassembly and the replica session. */
  private endApp(engine: Engine, ws: WebSocket, a: AppAttachment, code: number, reason: string): void {
    if (a.noise) {
      engine.noiseDrop(a.noise);
      this.readers.get(a.noise)?.wipe();
      this.readers.delete(a.noise);
    }
    if (a.session !== undefined) {
      engine.close(a.session);
      this.releaseAttachment(engine, a.session);
    }
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private async appMessage(engine: Engine, ws: WebSocket, a: AppAttachment, bytes: Uint8Array): Promise<void> {
    const live = this.live!;
    const collection = this.collection!;
    if (!a.noise) {
      // 1. The prologue, in clear.
      const grant = parsePrologue(bytes, collection, live.device);
      const h = grant ? engine.noiseStart(bytes) : 0;
      if (!grant || !h) return this.endApp(engine, ws, a, 1008, "prologue");
      this.readers.set(h, new FrameReader());
      ws.serializeAttachment({ ...a, noise: h, grant } satisfies AppAttachment);
      return;
    }
    if (a.session === undefined) {
      // 2. Noise message 1: the hello request; admitted, then answered in message 2.
      if (this.appSessions() >= MAX_APP_SESSIONS) return this.endApp(engine, ws, a, 1013, "busy");
      const m1 = engine.noiseRead1(a.noise, bytes);
      if (!m1) return this.endApp(engine, ws, a, 1008, "handshake");
      // The hello payload is wiped on every path, including an early denial.
      try {
        const ctx = { collection, op: "hello" as const, grant: a.grant, clientPk: m1.peer };
        if (!this.admitted(engine, ctx)) return this.endApp(engine, ws, a, 1008, "denied");
        const g = new Uint8Array(48);
        g.set(uuidBytes(a.grant!), 0);
        g.set(m1.peer, 16);
        const { session, response } = engine.hello(g, m1.payload);
        m1.payload.fill(0);
        let m2: Uint8Array | null;
        try {
          // The hello response is output: admitted again right before it leaves.
          if (!this.admitted(engine, { ...ctx, op: "output" })) {
            return this.endApp(engine, ws, { ...a, ...(session ? { session } : {}) }, 1008, "denied");
          }
          m2 = engine.noiseWrite2(a.noise, response);
        } finally {
          response.fill(0);
        }
        if (!m2) return this.endApp(engine, ws, a, 1011, "handshake");
        ws.send(m2);
        if (!session) {
          this.noteRefused(engine);
          return this.endApp(engine, ws, a, 1008, "refused");
        }
        ws.serializeAttachment({ ...a, session, client: toHex(m1.peer) } satisfies AppAttachment);
      } finally {
        m1.payload.fill(0);
      }
      await this.sync(engine);
      return;
    }
    // 3. Transport: frames, each admitted right before it reaches the replica.
    const plain = engine.noiseOpen(a.noise, bytes);
    const reader = this.readers.get(a.noise);
    let frames: Uint8Array[] | null;
    try {
      frames = plain && reader ? reader.push(plain) : null;
    } finally {
      plain?.fill(0);
    }
    if (!frames) return this.endApp(engine, ws, a, 1008, "frame");
    let held = 0;
    for (const r of this.readers.values()) held += r.buffered;
    if (held > MAX_APP_BUFFERED) {
      for (const f of frames) f.fill(0);
      return this.endApp(engine, ws, a, 1013, "busy");
    }
    try {
      for (const f of frames) {
        if (!this.admitted(engine, { collection, op: "call", grant: a.grant, clientPk: fromHex(a.client!) })) {
          return this.endApp(engine, ws, a, 1008, "denied");
        }
        await this.attachmentFrame(engine, a.session, f);
      }
    } finally {
      for (const f of frames) f.fill(0);
    }
    await this.sync(engine);
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (this.pitrClosed) { this.closePitrResources(); return; }
    const a = ws.deserializeAttachment() as AppAttachment | null;
    const engine = this.engine;
    if (!engine || !a || a.wake !== this.wakeId) {
      // Accepted before this wake: the session's state is gone. Re-handshake.
      ws.close(1012, "rehandshake");
      return;
    }
    this.noteActivity();
    if (a.app) {
      if (typeof message === "string" || message.byteLength > 65_535 || !this.live) return this.endApp(engine, ws, a, 1009, "frame");
      return this.appMessage(engine, ws, a, new Uint8Array(message));
    }
    if (typeof message === "string" || message.byteLength > MAX_FRAME_BYTES) {
      ws.close(1009, "frame");
      return;
    }
    const frame = new Uint8Array(message);
    if (a.session === undefined) {
      // LAB: the hosting app (no grant). Granted sessions need Noise + admission.
      const { session, response } = engine.hello(null, frame);
      ws.send(response);
      if (!session) {
        this.noteRefused(engine);
        ws.close(1008, "refused");
        return;
      }
      ws.serializeAttachment({ ...a, session });
    } else {
      await this.attachmentFrame(engine, a.session, frame);
    }
    await this.sync(engine);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    if (this.pitrClosed) { this.closePitrResources(); return; }
    await this.webSocketClose(ws);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.pitrClosed) { this.closePitrResources(); return; }
    const a = ws.deserializeAttachment() as AppAttachment | null;
    if (this.engine && a?.wake === this.wakeId) {
      if (a.noise) {
        this.engine.noiseDrop(a.noise);
        this.readers.get(a.noise)?.wipe();
        this.readers.delete(a.noise);
      }
      if (a.session !== undefined) {
        this.engine.close(a.session);
        this.releaseAttachment(this.engine, a.session);
      }
    }
    // Complete the close handshake: without the server's close frame the client
    // waits for its own timeout (LAB: ~23 s per close).
    try {
      ws.close(1000, "closed");
    } catch {
      // Already closed.
    }
  }
}

/** A socket's attachment: no key material, ever (Noise state lives in the engine). */
interface AppAttachment {
  wake: string;
  /** An app (Noise) socket rather than the LAB admin socket. */
  app?: boolean;
  /** When an app socket was accepted (ms): the oldest without a session is evicted first. */
  opened?: number;
  /** The engine's Noise session handle. */
  noise?: number;
  /** Grant ID from the prologue. */
  grant?: string;
  /** The authenticated client static key (public), hex. */
  client?: string;
  /** The replica session, once hello was accepted. */
  session?: number;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const health = labHealth(request, env.LAB === "1", env.CF_VERSION_METADATA?.id);
    if (health) return health;
    // A misconfigured hint refuses loudly instead of creating actors elsewhere.
    const hint = locationHint(env);
    if (hint === null) return new Response("DO location hint configuration", { status: 503 });
    const url = new URL(request.url);
    const e = env as unknown as { HOSTED_SERVICE_TOKEN?: string; SERVICE_KIND?: string; LAB_CUSTODY_WRAP_KEY?: string };
    const kind = e.SERVICE_KIND === "escrow" ? "escrow" : "hosted";
    // Optional isolated deployment settings; deployment generates the admitted profile.
    const p = env as Env & PitrFactorySettings & { PITR_PHASE?: R2Bucket };
    const isolated = pitrConfigured(env);
    const escrowFactory = url.pathname === "/pitr-escrow/internal/v1/service-devices";
    const factoryRequest = escrowFactory || url.pathname === "/internal/v1/service-devices";
    if (url.pathname.startsWith("/pitr-escrow/") && (!isolated || !escrowFactory)) {
      return new Response("not found", { status: 404 });
    }
    const pitr = isolated ? pitrFactory(p, p.PITR_PHASE) : null;
    if (isolated && (!pitr || !distinctServiceTokens(e.HOSTED_SERVICE_TOKEN, p.PITR_ESCROW_SERVICE_TOKEN) || !factoryRequest)) {
      // Keep every actor entry CLOSED until the all-path fence is installed.
      return new Response("unavailable", { status: 503 });
    }
    if (url.pathname === "/internal/v1/collection-mode/ready" || url.pathname === "/internal/v1/collection-mode/retire") {
      const input = await modeServiceRequest(request,e.HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) {
        if (env.LAB === "1" && input.status === 503) console.info(JSON.stringify({ event: "collection_mode_not_ready", reason: "invalid_internal_request" }));
        return input;
      }
      const operation = url.pathname.endsWith("/ready") ? "ready" : "retire";
      const stub = namedStub(env.COLLECTIONS,input.collection,hint);
      const headers = new Headers(request.headers); headers.delete("content-length");
      return stub.fetch(new Request(`${url.origin}/v1/hosted/collection-mode/${operation}?collection=${input.collection}`,
        {method:"POST",headers,body:JSON.stringify(input)}));
    }
    if (url.pathname === "/internal/v1/collections/initialize") {
      if (kind !== "hosted") return new Response("not found", { status: 404 });
      const input = await serviceInitialization(request, e.HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) return input;
      const { region, ...body } = input;
      const stub = namedStub(env.COLLECTIONS, input.collection, region ?? hint);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return stub.fetch(new Request(`${url.origin}/v1/hosted/initialize?collection=${input.collection}`, {
        method: "POST", headers, body: JSON.stringify(body), signal: request.signal,
      }));
    }
    if (url.pathname === "/v1/hosted/initialize") return new Response("not found", { status: 404 });
    if (url.pathname === "/internal/v1/collections/activate") {
      const activation = await serviceActivation(request, e.HOSTED_SERVICE_TOKEN);
      if (activation instanceof Response) return activation;
      const { collection } = activation;
      const stub = namedStub(env.COLLECTIONS, collection, activation.region ?? hint);
      return stub.fetch(new Request(`${url.origin}/v1/hosted/activate?collection=${collection}`, {
        method: "POST", headers: request.headers, body: JSON.stringify({ collection }),
      }));
    }
    if (factoryRequest) {
      // One canonical real generation/wrapping/wiping pipeline, no DO lookup.
      const role = escrowFactory ? "escrow" : kind;
      const wrapper = serviceDeviceWrapper(env as unknown as FactoryEnv, role) ?? DENY_WRAPPER;
      return generateServiceDevice(request, {
        serviceToken: escrowFactory ? p.PITR_ESCROW_SERVICE_TOKEN : e.HOSTED_SERVICE_TOKEN,
        generate: () => generateDeviceKeys(engineModule), wrapper, kind: role,
        labRawErrors: env.LAB === "1",
        ...(pitr ? { allowed: pitr.seedGuard() } : {}),
      });
    }
    const collection = url.searchParams.get("collection") ?? "";
    if (!url.pathname.startsWith("/v1/hosted/") || !UUID.test(collection)) {
      return new Response("not found", { status: 404 });
    }
    const stub = namedStub(env.COLLECTIONS, collection, hint);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
