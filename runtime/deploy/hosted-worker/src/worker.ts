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
import { Engine, type CppClaimTicket, type MigrationPendingTicket, type MigrationPhysicalTicket } from "./engine.js";
import type { MigrationProviderResult } from "./migration-provider-result.js";
import type { MigrationSourceResult } from "./migration-source-result.js";
import type { Gen0Result } from "./migration-gen0-input.js";
import { AlarmLifecycle } from "./alarm-lifecycle.ts";
import { attachmentSlots, ChunkBusy, type ChunkPermit } from "./chunk-slots.ts";
import { deploymentLog, pumpLog, PumpReport, StaleAppendStore, type CallTimings } from "./log.js";
import { DENY_ADMISSION, DENY_CUSTODY, DENY_WRAPPER, type Admission, type Custody, type OpenKeys } from "./seams.js";
import { distinctServiceTokens, generateServiceDevice, serviceActivation, serviceCollection } from "./service-devices.js";
import { PitrCut, PitrWork } from "./pitr-cut.ts";
import { PitrActorRestriction } from "./pitr-actor.ts";
import { pitrFactory, type PitrFactorySettings } from "./pitr-factory.ts";
import { modeServiceRequest, modeReady, modeAck, modeUnavailable } from "./collection-mode.js";
import { migrationAdmissionRequest, migrationAdmissionObservation, migrationAdmissionUnavailable } from "./migration-admission.ts";
import { generateDeviceKeys } from "./keygen.js";
import engineModule from "../hosted.wasm";
import { labCustody, labAuthorized } from "./lab.js";
import { labStubUnwrap, labStubWrapper } from "./custody-stub.js";
import { combinedCustody, cpCustody } from "./cp-custody.js";
import { ControlClient, type MigrationClaimData } from "./control.js";
import { IDLE, MigrationExecutor, SettlementRefused, SettlementUnknown, type MigrationHost } from "./migration-executor.ts";
import { connectClient } from "./migration-connect.ts";
import { hasGen0Objects, putGen0Object } from "./migration-objects.ts";
import { migrationOperatorBody, migrationOperatorRequest, type MigrationOperatorRequest } from "./migration-operator.ts";
import { PAUSE_REASON, STEP, atPreCutoverPause, migrationRunRequest, migrationStatus, migrationStatusRequest, newRun, readNativeState, storageRunStore, type RunRecord } from "./migration-run.ts";
import { migrationSampleBody, migrationSampleRequest, nativeSampleRequest } from "./migration-sample.ts";
import { LegacyBindingError, openLegacySource, type LegacySourceEnv, type PgConnect } from "./legacy-source/bindings.ts";
import { isPermanentCustodyRefusal, withCustodyRetry } from "./custody-retry.ts";
import { ProductionCustody, deploymentRelease, productionParts, productionWrapper, type FactoryEnv } from "./factory.ts";
import { localBuild, localOrigin } from "./local-origin.ts";
import { devicePublicKeys, verifyHostedGenesis } from "./keygen.js";
import { runIndex } from "./sql.js";
import { labHealth } from "./health.js";
import { locationHint, namedStub } from "./do-location.ts";
import { fetchAttachment } from "./object-reads.js";
import { deploymentObjectOrigins, type ObjectOriginPolicy } from "./object-origins.ts";
import { grantRecipients, hasGrantAppend, wakeCollectionTag, wakeLog } from "./wake-observe.ts";
import { PIN_RESET_KEY, PinParked, isPinMismatch, pinLog, pinsDigest } from "./pin-reset.ts";
import { labRawError, readyDiagnostic, type ReadyDiagnostic, type ReadyTrace } from "./ready-diagnostic.ts";
import { LiveAdmission, type AdmissionContext } from "./admission/live-admission.ts";
import { FrameReader, MAX_APP_BUFFERED, MAX_APP_SESSIONS, MAX_APP_SOCKETS, evidence, frameChunks, parsePrologue, uuidString } from "./app.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** Socket-independent hosted polling fallback; committed CP policy also wakes it. */
const REFRESH_MS = 30_000;
/** A failed engine open retries after REFRESH_MS, doubling per consecutive
 * failure up to this many doublings (16 min), so actors that cannot open (control
 * plane refusing, a store built under other keys) stop flooding the control
 * plane. A CP activation still opens at once. */
const OPEN_BACKOFF_STEPS = 5;
const OPEN_FAILURES_KEY = "service-open-failures";
const openRetryMs = (failures: number) =>
  REFRESH_MS * 2 ** Math.min(Math.max(0, Math.floor(failures)), OPEN_BACKOFF_STEPS) + Math.floor(Math.random() * 5_000);
/** The escrow learns of new enrolments at least this often (no push from the log). */
const ESCROW_POLL_MS = 60_000;
/** Idle back-off: each sync that learns nothing new doubles the polling interval
 * (hosted 30 s, escrow 60 s) up to this cap. Every idle actor polled the log, and
 * minted a log token, every 30-60 s; with hundreds of collections that held the
 * control plane busy. Any activity resets to the base interval: a client request
 * or open client socket, a CP activation, a local write, or a sync that moved
 * anything but head checks (a new remote head means reads). The log has no push
 * to hosted actors, so there is no notification to reset on. */
const IDLE_POLL_CAP_MS = 10 * 60_000;
const IDLE_STREAK_KEY = "service-idle-streak";
const IDLE_SAME_LOOK_MS = 5_000;
/** Doublings that reach the cap from the smaller (hosted) base. */
const IDLE_MAX_STREAK = 5;
export const idlePollMs = (base: number, streak: number) =>
  Math.min(IDLE_POLL_CAP_MS, base * 2 ** Math.min(Math.max(0, Math.floor(streak)), IDLE_MAX_STREAK));
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

/** An encoded index Reset request (drop the `st_*` tables). */
const RESET = Uint8Array.of(0x4d, 0x44, 0x42, 0x49, 0x44, 0x58, 0x00, 0x01, 1);

function pitrConfigured(env: Env): boolean {
  const p = env as Env & PitrFactorySettings & { PITR_PHASE?: R2Bucket };
  return p.PITR_BINDING !== undefined || p.PITR_MINIMUM_EPOCH !== undefined
    || p.PITR_ESCROW_SERVICE_TOKEN !== undefined || p.PITR_PHASE !== undefined;
}

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
  private collection: string | null = null;
  private readonly objectOrigins: ObjectOriginPolicy;
  private custody: Custody;
  private admission: Admission;
  private lastRefresh = 0;
  /** Consecutive syncs that learned nothing new (persisted: survives eviction). */
  private idleStreak: number | null = null;
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
    this.cppControl=parts?.control??null;
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
  private readonly cppControl: ControlClient|null=null;
  /** Actual host confirmation provenance; not serialized or inferred from IDs. */
  /** The claim the last migration prepare read (DATA for claim-bound calls). */
  #migrationClaim: MigrationClaimData | null = null;
  #migrationOperatorRunning = false;
  readonly #migrationConfirmed = new WeakMap<MigrationPendingTicket, { engine: Engine; generation: number }>();

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

  /** LAB diagnosis only: which fence a migration step failed, as fixed booleans. */
  private hostChanged(site: string, facts: Record<string, boolean>): Error {
    if (this.env.LAB === "1") {
      try { console.info(JSON.stringify({ event: "migration_host_changed", site, ...facts })); } catch { /* Logging is not authority. */ }
    }
    return new Error("migration_host_changed");
  }

  /** An engine teardown that fences in-flight migration steps: the held log token
   * goes with it (LAB also logs the site). */
  private engineReset(site: string): void {
    this.dropLogToken();
    if (this.env.LAB === "1") {
      try { console.info(JSON.stringify({ event: "hosted_engine_reset", site })); } catch { /* Logging is not authority. */ }
    }
  }

  /** Closed native/owned-Control exchange, then actual physical journal ACK.
   * Internal action-host seam only: no operator route or H1/effect permission.
   * No caller owner/key/audience/result/ACK inputs; original CPP receipt is DATA. */
  private async ownedMigrationClaim<T>(signal: AbortSignal, use: (engine: Engine, generation: number, cpp: CppClaimTicket, claim: MigrationClaimData, check: () => void) => Promise<T>,
    open = true): Promise<T> {
    const engine = this.engine, control = this.cppControl;
    if (!engine || !control || this.escrow) throw new Error("migration_host_unavailable");
    await this.requireBackground();
    if (this.engine !== engine || this.cppControl !== control) {
      throw this.hostChanged("claim_background", { engine: this.engine === engine, control: this.cppControl === control });
    }
    const generation = this.logGen;
    const cpp = engine.beginCppClaim();
    let challenge: Uint8Array | undefined, signature: Uint8Array | undefined;
    const check = (): void => {
      if (signal?.aborted || this.engine !== engine || this.collection !== cpp.collection ||
          this.logGen !== generation || !this.alarms.current) {
        throw this.hostChanged("claim_check", { aborted: !!signal?.aborted, engine: this.engine === engine,
          collection: this.collection === cpp.collection, generation: this.logGen === generation, alarm: this.alarms.current });
      }
      this.requirePhysicalCollection(cpp.collection);
      engine.assertCppClaimCurrent(cpp);
    };
    try {
      check();
      challenge = await control.migrationClaimChallenge(cpp.collection, cpp.device, signal);
      check();
      signature = engine.signCppClaimChallenge(cpp, challenge);
      const hex = (b: Uint8Array): string => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
      const claim = this.#migrationClaim = await control.migrationClaimRead(cpp.collection, {
        device_id: cpp.device, challenge: hex(challenge), sig: hex(signature),
      }, signal);
      check();
      if (open) engine.openMigrationDriver(cpp, claim);
      return await use(engine, generation, cpp, claim, check);
    } finally {
      challenge?.fill(0); signature?.fill(0); engine.finishCppClaim(cpp);
    }
  }

  private prepareMigrationPending(signal: AbortSignal): Promise<MigrationPendingTicket> {
    return this.ownedMigrationClaim(signal, async (engine, generation, _cpp, _claim, current) => {
      let pending: MigrationPendingTicket | undefined, physical: MigrationPhysicalTicket | undefined;
      const check = () => { current(); if (pending) engine.assertMigrationPendingCurrent(pending); };
      try {
        pending = engine.beginMigrationPending();
        check();
        // Only the platform's actual promise confirms prior SQL/KV writes.
        physical = engine.beginMigrationPhysical(pending);
        engine.assertMigrationPhysicalCurrent(physical);
        await this.ctx.storage.sync();
        check();
        engine.finishMigrationPhysical(physical);
        this.#migrationConfirmed.set(pending, { engine, generation });
        return pending;
      } catch (error) {
        if (pending) engine.finishMigrationPending(pending); // DB stays UNKNOWN.
        throw error;
      } finally { if (physical) engine.closeMigrationPhysical(physical); }
    });
  }

  private async operateMigration(input: MigrationOperatorRequest, signal: AbortSignal): Promise<void> {
    const store = storageRunStore(this.ctx.storage), run = await store.load();
    if (!run || run.collection !== input.collection || (run.state !== "stopped" && run.state !== "done")) throw new Error("migration_operator_busy");
    await this.ownedMigrationClaim(signal, async (engine, _generation, cpp, claim, check) => {
      const native = readNativeState(this.ctx.storage.sql);
      if (input.operation === "abandon") {
        if (native.outstanding?.kind !== 6 || native.outstanding.sequence !== input.expectedSequence) throw new Error("migration_operator_conflict");
        run.state = "stopped"; run.reason = "operator_abandoned:AppendBase"; run.updatedAt = Date.now();
        await store.save(run);
        check(); // UNKNOWN row and checkpoint were never changed.
        return;
      }
      if (input.operation === "resume") {
        if (!run.pauseBeforeCutover || run.resumeRunSequence !== null || run.state !== "stopped" || run.reason !== PAUSE_REASON) throw new Error("migration_operator_conflict");
        const paused = (): void => {
          check();
          const current = readNativeState(this.ctx.storage.sql);
          if (current.runSequence !== input.expectedSequence || !atPreCutoverPause(current)) throw new Error("migration_operator_conflict");
        };
        paused();
        await this.ctx.storage.sync();
        paused();
        run.resumeRunSequence = input.expectedSequence;
        run.state = "running"; run.reason = null; run.refusals = 0; run.updatedAt = Date.now();
        await store.save(run);
        paused();
        return;
      }
      if (input.operation === "rollback" || input.operation === "restart") {
        if (native.outstanding && !(input.operation === "rollback" && [4, 5].includes(native.outstanding.kind)
            && native.checkpoint?.step === STEP.created)) throw new Error("migration_operator_outstanding_unknown");
        if (input.operation === "restart") {
          engine.restartMigrationDriver(cpp, claim, input.expectedSequence);
        } else {
          let source: unknown | null = null;
          if (native.checkpoint?.fenced && native.checkpoint.step !== 20) {
            const e = this.env as unknown as { CP_URL?: string; CP_MIGRATION_TOKEN?: string };
            const reply = await connectClient({ url: e.CP_URL ?? "", token: e.CP_MIGRATION_TOKEN ?? "", environment: deploymentRelease(this.env as unknown as FactoryEnv)?.environment }).source(input.collection, signal);
            check();
            if (reply.status < 200 || reply.status >= 300) throw new Error("migration_rollback_source_unavailable");
            source = reply.body;
          }
          engine.requestMigrationRollback(cpp, claim, input.expectedSequence, source);
        }
        await this.ctx.storage.sync();
        check();
        const next = input.operation === "restart" ? newRun(input.collection, run.backupHold, Date.now(), run.pauseBeforeCutover) : run;
        next.state = "running"; next.reason = null; next.refusals = 0; next.updatedAt = Date.now();
        await store.save(next);
        check();
        return;
      }
      const pending = native.outstanding;
      if (!pending || pending.sequence !== input.expectedSequence || ![6, 20, 21].includes(pending.kind)) throw new Error("migration_operator_conflict");
      let receipt: unknown;
      if (pending.kind !== 6) {
        const scope = engine.migrationUnknownRollbackScope(pending.sequence);
        const e = this.env as unknown as { CP_URL?: string; CP_MIGRATION_TOKEN?: string };
        const reply = await connectClient({ url: e.CP_URL ?? "", token: e.CP_MIGRATION_TOKEN ?? "", environment: deploymentRelease(this.env as unknown as FactoryEnv)?.environment }).rollbackReceipt(input.collection,
          { owner_account: claim.owner_account, started_us: claim.started_us, migration_id: scope.providerMigrationId }, scope, signal);
        check();
        if (reply.status < 200 || reply.status >= 300) throw new Error("migration_receipt_unknown");
        receipt = reply.body;
      }
      let settled: MigrationPendingTicket | undefined, physical: MigrationPhysicalTicket | undefined;
      try {
        check();
        settled = engine.resolveMigrationAction(cpp, claim, pending.sequence, receipt);
        physical = engine.beginMigrationPhysical(settled);
        engine.assertMigrationPhysicalCurrent(physical);
        await this.ctx.storage.sync();
        check();
        engine.assertMigrationSettlementCurrent(settled);
        engine.finishMigrationPhysical(physical);
        engine.assertMigrationSettlementConfirmed(settled);
        run.state = "running"; run.reason = null; run.refusals = 0; run.updatedAt = Date.now();
        await store.save(run);
        check();
      } finally {
        if (physical) engine.closeMigrationPhysical(physical);
        if (settled) engine.finishMigrationPending(settled);
      }
    });
    if (input.operation !== "abandon") await this.alarms.schedule(Date.now() + 100, () => this.alarms.current);
  }

  /** A re-armed account's fresh attempt (`run` with a new hold): only a fully rolled-back,
   * unfenced run with nothing outstanding is replaced, by a native run bound to the CP
   * claim's strictly newer start; native refuses anything else. A committed supersede
   * whose run record was lost reopens under the same claim. Caller holds the operator flag. */
  private async supersedeMigration(run: RunRecord, hold: string, pauseBeforeCutover: boolean, signal: AbortSignal): Promise<void> {
    const store = storageRunStore(this.ctx.storage);
    await this.ownedMigrationClaim(signal, async (engine, _generation, cpp, claim, check) => {
      const native = readNativeState(this.ctx.storage.sql), cp = native.checkpoint;
      if (native.outstanding || !cp || native.runSequence === null) throw new Error("migration_run_exists");
      if (cp.step === STEP.rolledBack && !cp.fenced) engine.supersedeMigrationDriver(cpp, claim, native.runSequence);
      else if (cp.step === STEP.start && native.runSequence > 1) {
        engine.openMigrationDriver(cpp, claim);
        // Only a supersede changes the start; a lost operator restart keeps it.
        const prior = engine.migrationRun(native.runSequence - 1);
        if (!Array.isArray(prior) || typeof prior[4] !== "string" || prior[4] === claim.started_us) throw new Error("migration_run_exists");
      } else throw new Error("migration_run_exists");
      await this.ctx.storage.sync();
      check();
      // Each later action re-validates its own claim; the alarm runs the saved record.
      await store.save(newRun(run.collection, hold, Date.now(), pauseBeforeCutover));
    }, false);
  }

  /** VOID exact original host-confirmed pending, no H1/effect conversion. */
  private assertMigrationConfirmed(ticket: MigrationPendingTicket): void {
    const original = this.#migrationConfirmed.get(ticket);
    if (!original || original.engine !== this.engine || original.generation !== this.logGen ||
        this.collection !== ticket.collection || !this.alarms.current) {
      throw this.hostChanged("confirmed", { original: !!original, engine: original?.engine === this.engine,
        generation: original?.generation === this.logGen, collection: this.collection === ticket.collection, alarm: this.alarms.current });
    }
    this.requirePhysicalCollection(ticket.collection);
    original.engine.assertMigrationPendingCurrent(ticket);
  }

  private commitMigrationKeyingWait(ticket: MigrationPendingTicket, signal?: AbortSignal): Promise<string> {
    return this.#commitMigrationSettlement(ticket, "keying-wait", signal);
  }

  /** Internal authenticated action host only; native derives target completion.
   * This is not reachable from the read-only admission observation route. */
  #commitMigrationTargetCreated(ticket: MigrationPendingTicket, signal?: AbortSignal): Promise<string> {
    return this.#commitMigrationSettlement(ticket, "target-created", signal);
  }

  /** Internal action host only: one Connect/provider body from the action's own
   * migration-token request. Native binds it; no caller Outcome/ACK data. */
  #commitMigrationProviderResult(ticket: MigrationPendingTicket, result: MigrationProviderResult, signal?: AbortSignal): Promise<string> {
    return this.#commitMigrationSettlement(ticket, result, signal);
  }

  /** Internal action host only: one legacy source open/page result from the
   * action's own bounded source read. Native binds it; no caller Outcome/ACK. */
  #commitMigrationSourceResult(ticket: MigrationPendingTicket, result: MigrationSourceResult, signal?: AbortSignal): Promise<string> {
    return this.#commitMigrationSettlement(ticket, { source: result }, signal);
  }

  /** Internal action host only: HasObjects flags over the addresses native
   * returned for the pending generation-0 window or finish, after the action's
   * own uploads. Native binds them; no caller Outcome/ACK. */
  #commitMigrationGen0Result(ticket: MigrationPendingTicket, result: Gen0Result, signal?: AbortSignal): Promise<string> {
    return this.#commitMigrationSettlement(ticket, { gen0: result }, signal);
  }

  /** Internal action host only: the pending log action, settled by native from
   * the Engine's own log evidence. No caller input, Outcome or ACK. */
  #commitMigrationLogResult(ticket: MigrationPendingTicket, signal?: AbortSignal): Promise<string> {
    return this.#commitMigrationSettlement(ticket, "log", signal);
  }

  /** SAME original native settlement/checkpoint and actual physical ACK before
   * output. Fixed internal operation selectors, never caller Outcome/ACK data. */
  async #commitMigrationSettlement(ticket: MigrationPendingTicket, action: "keying-wait" | "target-created" | "log" | MigrationProviderResult | { source: MigrationSourceResult } | { gen0: Gen0Result } | { rollback: unknown }, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw this.hostChanged("settlement_start", { aborted: true });
    this.assertMigrationConfirmed(ticket);
    const original = this.#migrationConfirmed.get(ticket)!;
    let result: string;
    try {
      result = action === "keying-wait" ? original.engine.recordMigrationKeyingWait(ticket)
        : action === "target-created" ? original.engine.recordMigrationTargetCreated(ticket)
        : action === "log" ? original.engine.recordMigrationLogResult(ticket)
        : "source" in action ? original.engine.recordMigrationSourceResult(ticket, action.source)
        : "gen0" in action ? original.engine.recordMigrationGen0Result(ticket, action.gen0)
        : "rollback" in action ? original.engine.recordMigrationRollbackResult(ticket, action.rollback)
        : original.engine.recordMigrationProviderResult(ticket, action);
    } catch (error) {
      // Settlement and checkpoint are one SQL transaction: an unsettled row
      // means nothing was written and the ticket is still live.
      const row = this.ctx.storage.sql.exec<{ settled: number }>(
        "SELECT settled FROM mig_native_action WHERE seq=?", ticket.sequence).toArray()[0];
      if (row?.settled === 0) throw new SettlementRefused(error instanceof Error ? error.message : "migration_settlement_refused");
      throw new SettlementUnknown("migration_settlement_unknown");
    }
    // From here any error is UNKNOWN despite a potentially landed settlement.
    const physical = original.engine.beginMigrationPhysical(ticket);
    try {
      original.engine.assertMigrationPhysicalCurrent(physical);
      await this.ctx.storage.sync();
      if (signal?.aborted || this.engine !== original.engine || this.logGen !== original.generation ||
          this.collection !== ticket.collection || !this.alarms.current) {
        throw this.hostChanged("settlement_sync", { aborted: !!signal?.aborted, engine: this.engine === original.engine,
          generation: this.logGen === original.generation, collection: this.collection === ticket.collection, alarm: this.alarms.current });
      }
      this.requirePhysicalCollection(ticket.collection);
      original.engine.assertMigrationSettlementCurrent(ticket);
      original.engine.finishMigrationPhysical(physical);
      original.engine.assertMigrationSettlementConfirmed(ticket);
      this.#migrationConfirmed.delete(ticket);
      original.engine.finishMigrationPending(ticket);
      return result;
    } catch (error) { throw new SettlementUnknown(error instanceof Error ? error.message : "migration_settlement_unknown"); }
    finally { original.engine.closeMigrationPhysical(physical); }
  }

  /** The legacy Postgres client factory (`pg`), installed by the deployment
   * that enables the legacy bindings (needs `nodejs_compat`); unset, the
   * source refuses with `legacy_source_unconfigured`. */
  static legacyConnect: PgConnect | null = null;
  #executorInstance: MigrationExecutor | null = null;

  /** Whether this deployment can run a migration at all (no secret values). */
  private migrationConfigured(): boolean {
    const e = this.env as unknown as { CP_URL?: string; CP_MIGRATION_TOKEN?: string };
    return !this.escrow && !this.pitrClosed && !!this.cppControl && (!!e.CP_URL?.startsWith("https://") || localOrigin(e.CP_URL ?? "", deploymentRelease(this.env as unknown as FactoryEnv)?.environment))
      && (e.CP_MIGRATION_TOKEN?.length ?? 0) >= 32;
  }

  /** The executor's private bridge to this DO's native ledger and log. */
  private migrationHost(): MigrationHost {
    const engine = (): Engine => {
      if (!this.engine) throw new Error("migration_host_unavailable");
      return this.engine;
    };
    const confirmed = (t: MigrationPendingTicket): Engine => { this.assertMigrationConfirmed(t); return engine(); };
    const fence = (e: Engine) => { const gen = this.logGen; return () => this.engine === e && this.logGen === gen && this.alarms.current; };
    return {
      state: () => readNativeState(this.ctx.storage.sql),
      claim: () => this.#migrationClaim && { owner_account: this.#migrationClaim.owner_account, started_us: this.#migrationClaim.started_us },
      prepare: async (signal) => {
        let ticket: MigrationPendingTicket;
        try { ticket = await this.prepareMigrationPending(signal); }
        catch (error) {
          // Only a null pending begin carries a fresh native idle reason.
          const e = this.engine;
          return { idle: e && error instanceof Error && error.message === "migration_pending_refused" ? e.migrationIdle() : IDLE.unavailable };
        }
        try { return { ticket, fields: engine().migrationPendingAction(ticket) }; }
        catch (error) { this.engine?.finishMigrationPending(ticket); this.#migrationConfirmed.delete(ticket); throw error; }
      },
      keyingWait: (t, signal) => this.commitMigrationKeyingWait(t, signal),
      targetCreated: (t, signal) => this.#commitMigrationTargetCreated(t, signal),
      provider: (t, result, signal) => this.#commitMigrationProviderResult(t, result, signal),
      rollbackScope: (t) => confirmed(t).migrationRollbackScope(t),
      rollbackResult: (t, body, signal) => this.#commitMigrationSettlement(t, { rollback: body }, signal),
      source: (t, result, signal) => this.#commitMigrationSourceResult(t, result, signal),
      gen0Placements: (t) => confirmed(t).migrationGen0Placements(t),
      gen0FileChunk: (t, input) => confirmed(t).migrationGen0FileChunk(t, input),
      gen0Window: (t, input) => confirmed(t).migrationGen0Window(t, input),
      gen0Finish: (t) => confirmed(t).migrationGen0Finish(t),
      gen0Result: (t, result, signal) => this.#commitMigrationGen0Result(t, result, signal),
      logAppend: (t) => confirmed(t).migrationLogAppend(t),
      logResult: (t, signal) => this.#commitMigrationLogResult(t, signal),
      release: (t) => { this.engine?.finishMigrationPending(t); this.#migrationConfirmed.delete(t); },
      // Ticks first, as the alarm does: retries can now repeat inside one wake.
      pump: async (_signal, head) => { const e = this.engine; if (e) { if (head) e.requestHead(); e.tick(Date.now()); await this.sync(e); } },
      resetForRebuild: async () => {
        const collection = this.collection;
        if (!collection || this.opening) throw new Error("migration_host_unavailable");
        if (this.engine) this.releaseAttachment(this.engine);
        this.engineReset("migration_rebuild");
        this.logGen++;
        this.engine = null;
        this.live = null;
        for (const r of this.readers.values()) r.wipe();
        this.readers.clear();
        // Drops only the `st_*` cache tables; the migration ledger stays.
        runIndex(this.ctx.storage, RESET);
        await this.ready(collection);
      },
      putObject: async (collection, object, signal) => {
        const e = engine(), live = fence(e), current = () => live() && !signal.aborted, token = await this.token();
        await putGen0Object(this.log(), e, token, collection, object, current, signal);
      },
      hasObjects: async (collection, addresses, signal) => {
        const e = engine(), live = fence(e), current = () => live() && !signal.aborted, token = await this.token();
        return hasGen0Objects(this.log(), e, token, collection, addresses, current);
      },
    };
  }

  /** The real source boundary; constructing bindings does not query or unwrap. */
  protected async legacyMigrationSource(collection: string) {
    const connect = HostedCollection.legacyConnect;
    if (!connect) throw new LegacyBindingError("legacy_source_unconfigured", "no legacy database client in this deployment");
    return openLegacySource(this.env as Env & LegacySourceEnv, collection, { connect });
  }

  private migrationExecutor(collection: string): MigrationExecutor {
    const e = this.env as unknown as { CP_URL?: string; CP_MIGRATION_TOKEN?: string } & LegacySourceEnv;
    return this.#executorInstance ??= new MigrationExecutor({
      collection, host: this.migrationHost(), store: storageRunStore(this.ctx.storage),
      connect: () => connectClient({ url: e.CP_URL ?? "", token: e.CP_MIGRATION_TOKEN ?? "", environment: deploymentRelease(this.env as unknown as FactoryEnv)?.environment }),
      source: () => this.legacyMigrationSource(collection),
    });
  }

  /** The alarm-driven loop: run the executor's wake, schedule the next. */
  private async migrationWake(): Promise<void> {
    if (!this.collection || !this.engine || !this.migrationConfigured()) return;
    const run = await storageRunStore(this.ctx.storage).load();
    if (!run || run.collection !== this.collection || run.state === "stopped" || run.state === "done") return;
    // The executor's own budget (60 s) bounds starting actions; this backstop only
    // fences a stuck one. It must outlast an action started in budget: token/sealer
    // fetches retry for up to 45 s each, and an abort at settlement stops the run.
    const result = await this.migrationExecutor(this.collection).wake(AbortSignal.timeout(600_000));
    if (result.nextAt !== null) await this.alarms.schedule(result.nextAt, () => this.alarms.current);
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
    // Persist a retry before custody/network work; failed first-open must not
    // leave a registered service device without an alarm.
    let openFailures = 0;
    if (!this.engine) {
      trace.stage = "open_retry_read";
      const stored = await this.ctx.storage.get<unknown>(OPEN_FAILURES_KEY);
      openFailures = typeof stored === "number" && Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
      trace.stage = "open_retry_schedule";
      await this.alarms.schedule(Date.now() + openRetryMs(openFailures), () => !this.engine);
    }
    trace.stage = "alarm_guard";
    if (!this.alarms.current) throw new Error("hosted_alarm_inhibited");
    if (this.engine) return this.engine;
    const openingTrace = this.openingTrace ??= { stage: "custody_open_sealer" };
    trace.opening = openingTrace;
    this.opening ??= (async () => {
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
        const config=openConfig(collection,keys,this.escrow);
        try {
          openingTrace.stage = this.cppControl ? "engine_cpp_open" : "engine_open";
          if(this.cppControl) engine.openForCppClaim(config,this.cppControl);
          else engine.open(config); // No CPP signer in escrow/LAB-fixture/unconfigured opens.
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
      await this.sync(engine, calls);
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
      if (engine.needsReset()) {
        // The cache disagrees with the log: drop every store table and rebuild.
        this.releaseAttachment(engine);
        this.engineReset("cache_reset");
        this.logGen++;
        this.engine = null;
        this.live = null;
        for (const r of this.readers.values()) r.wipe();
        this.readers.clear();
        runIndex(this.ctx.storage, RESET);
        throw new Error("hosted cache reset; retry");
      }
      return engine;
    })().then(async (engine) => {
      openingTrace.stage = "open_failure_clear";
      if (openFailures) await this.ctx.storage.delete(OPEN_FAILURES_KEY);
      return engine;
    }, async (error: unknown) => {
      if (isPermanentCustodyRefusal(error)) { await this.retireForVerdict(); throw error; }
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
    runIndex(this.ctx.storage, RESET);
    await this.ctx.storage.put(PIN_RESET_KEY, pins);
    pinLog(await wakeCollectionTag(collection), this.escrow ? "escrow" : "hosted", "pin_reset");
    await this.alarms.schedule(Date.now() + REFRESH_MS, () => !this.engine);
    throw new Error("hosted cache reset after pin mismatch; retry");
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

  /** Custody gave a lasting verdict (the KMS does not serve the collection, or the
   * CP holds no current service device: deleted / left sync). Stop being a
   * background actor for it: drop the live engine and its sessions, drop the
   * rebuildable `st_*` cache (the migration ledger stays), forget the open
   * backoff and cancel the alarm, so no timer wakes this collection again. Only a
   * new CP activation or app connection re-evaluates custody; a transient
   * refusal never reaches here and keeps its backed-off retry alarm. */
  private async retireForVerdict(): Promise<void> {
    if (this.engine) {
      this.releaseAttachment(this.engine);
      this.engineReset("custody_verdict");
      this.logGen++;
      this.engine = null;
      this.live = null;
      for (const r of this.readers.values()) r.wipe();
      this.readers.clear();
    }
    runIndex(this.ctx.storage, RESET);
    await this.ctx.storage.delete(OPEN_FAILURES_KEY);
    await this.ctx.storage.deleteAlarm();
    if (this.env.LAB === "1") {
      try { console.info(JSON.stringify({ event: "hosted_custody_verdict_retired", role: this.escrow ? "escrow" : "hosted" })); } catch { /* Logging is not authority. */ }
    }
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

  /** LAB diagnosis only: each transient custody refusal a fetch retried. */
  private custodyRetryOptions(fetch: "open_sealer" | "log_token") {
    return this.env.LAB === "1" ? { onRetry: (facts: { attempt: number; code: string; call: string | null; name: string | null; message: string | null }) =>
      console.info(JSON.stringify({ event: "custody_retry", fetch, ...facts })) } : {};
  }

  /** Move log traffic until quiet, deliver output, schedule the next wakeup. */
  private async sync(engine: Engine, timings?: CallTimings): Promise<void> {
    if (this.pitrClosed) { this.closePitrResources(); return; }
    const gen = this.logGen;
    const current = () => !this.pitrClosed && this.alarms.current && this.logGen === gen && this.engine === engine;
    if (!await this.alarms.allowed() || !current()) return;
    const tag = this.env.LAB === "1" && this.collection ? await wakeCollectionTag(this.collection) : null;
    if (!current()) return;
    const report = new PumpReport();
    let delivered = 0;
    await pumpLog(this.log(), engine, this.token, current, this.staleAppends, 64, timings, tag ? (call) => {
      if (current() && hasGrantAppend(call.frame)) wakeLog(tag, this.escrow ? "escrow" : "hosted", "grant_emitted", undefined, grantRecipients(call.frame));
    } : undefined, tag ? (call, observation) => {
      if (current() && hasGrantAppend(call.frame)) wakeLog(tag, this.escrow ? "escrow" : "hosted", "grant_append_outcome", observation);
    } : undefined, { tokenRefused: () => this.dropLogToken(), report });
    if (!current() || !await this.checkPinRebuild(engine) || !current()) return;
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
    const active = this.activitySeen || !report.quiet || delivered > 0 || this.clientOpen();
    this.activitySeen = false;
    const pollMs = await this.idlePoll(active, current);
    if (!current()) return;
    const next = engine.nextWakeup();
    const poll = Date.now() + pollMs;
    // Preserve earlier deadlines; inhibited or stale storage continuations must
    // not schedule another wake. This local fence is not deletion currentness.
    await this.alarms.schedule(Math.min(next ?? poll, poll), current);
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

  async alarm(): Promise<void> {
    if (this.pitrClosed) {
      this.closePitrResources();
      await this.pitrWork!.trackClosed(() => this.ctx.storage.deleteAlarm());
      return; // No stored collection lookup, custody, tick, refresh or reschedule.
    }
    if (!await this.alarms.allowed()) {
      await this.alarms.inhibit();
      return;
    }
    if (!this.engine) {
      // Keep the old escrow key readable for existing enrolled DOs.
      const collection = await this.ctx.storage.get<string>("service-collection")
        ?? (this.escrow ? await this.ctx.storage.get<string>("escrow-collection") : undefined);
      if (collection && UUID.test(collection)) {
        // A permanent verdict already retired the actor (no alarm left); return
        // normally so the platform does not retry the alarm either.
        try { await this.ready(collection); } catch (error) { if (error instanceof PinParked || isPermanentCustodyRefusal(error)) return; throw error; }
      }
    }
    if (!await this.alarms.allowed() || !this.engine || !this.collection) return;
    const engine = this.engine;
    engine.tick(Date.now());
    if (this.escrow || Date.now() - this.lastRefresh >= REFRESH_MS) {
      this.lastRefresh = Date.now();
      engine.refresh();
    }
    try { await this.sync(engine); }
    catch (error) {
      // A warm engine learns of deletion through its next log token.
      if (!isPermanentCustodyRefusal(error)) throw error;
      await this.retireForVerdict();
      return;
    }
    await this.migrationWake();
  }

  async fetch(request: Request): Promise<Response> {
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
      if (input instanceof Response) return input;
      if (input.collection !== collection) return modeUnavailable();
      if (url.pathname.endsWith("/retire")) {
        // Join any existing open OUTSIDE the short storage-only critical section.
        try { if (this.opening) await this.opening; } catch { /* Refusal may already retire it. */ }
        return this.ctx.blockConcurrencyWhile(async () => {
          try {
            if (this.opening) return modeUnavailable();
            this.requirePhysicalCollection(collection);
            const device = await this.ctx.storage.get<string>("collection-mode-device");
            if (device && device !== input.device || this.live && this.live.device !== input.device) return modeUnavailable();
            await this.retireForVerdict();
            return modeAck(input); // Rebuildable cache retirement, not physical erasure.
          } catch { return modeUnavailable(); }
        });
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
        const observation = engine.modeServiceReady();
        if (!modeReady(observation,input)) return refuse(observation === null ? "native_not_ready" : "native_identity_mismatch",
          { serving: engine.serving(), reset: engine.needsReset(), pin: engine.pinState() });
        return modeAck(input);
      } catch (error) { return refuse("exception", { diagnostic: diagnostic ?? readyDiagnostic("unknown", error) }); }
    }
    if (url.pathname === "/v1/hosted/migration-admission") {
      if (this.escrow) return new Response("not found", { status: 404 });
      const input = await migrationAdmissionRequest(request, (this.env as Env & { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) return input;
      if (input.collection !== collection) return new Response("bad collection", { status: 400, headers: { "cache-control": "no-store" } });
      // Observation ONLY: never ready()/refresh()/sync(), custody, bootstrap,
      // app sessions or object effects. A cold/opening wake must be activated
      // separately; persisted SQL/status cannot substitute for live custody.
      const engine = this.engine;
      const live = this.live;
      if (!engine || this.opening || !live || live.engine !== engine || this.collection !== collection ||
        !this.admitted(engine, { collection, op: "wake" })) return migrationAdmissionUnavailable();
      try {
        const observation = migrationAdmissionObservation(engine.admission(), input, live.device);
        return observation
          ? Response.json(observation, { headers: { "cache-control": "no-store" } })
          : migrationAdmissionUnavailable();
      } catch { return migrationAdmissionUnavailable(); }
    }
    if (url.pathname === "/v1/hosted/migration/operator") {
      if (this.escrow) return new Response("not found", { status: 404 });
      const token = (this.env as unknown as { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN;
      const input = await migrationOperatorRequest(request, token);
      if (input instanceof Response) return input;
      if (input.collection !== collection) return Response.json({ error: "invalid_request" }, { status: 400 });
      if (!this.migrationConfigured()) return Response.json({ error: "migration_unconfigured" }, { status: 503 });
      // Serialize operator intent before the first await; an overlapping request
      // must not release the same paused run or interrupt a live continuation.
      if (this.#migrationOperatorRunning) return Response.json({ error: "migration_operator_busy" }, { status: 409 });
      this.#migrationOperatorRunning = true;
      try {
        const before = await storageRunStore(this.ctx.storage).load();
        if (!before || (before.state !== "stopped" && before.state !== "done")) {
          return Response.json({ error: "migration_operator_busy" }, { status: 409 });
        }
        await this.ready(collection);
        await this.operateMigration(input, AbortSignal.timeout(60_000));
        return Response.json(migrationStatus(await storageRunStore(this.ctx.storage).load(), readNativeState(this.ctx.storage.sql)),
          { headers: { "cache-control": "no-store" } });
      } catch (error) {
        // Do not leave a reactivated job runnable after its final context/commit
        // check failed. Invalid requests leave the already-stopped job unchanged.
        const store = storageRunStore(this.ctx.storage), current = await store.load();
        if (current?.state === "running") {
          current.state = "stopped"; current.reason = "operator_outcome_unknown"; current.updatedAt = Date.now();
          await store.save(current);
        }
        // A failed physical confirmation may follow a landed write. Preserve
        // exact UNKNOWN/settled evidence; never infer undone.
        return Response.json({ error: error instanceof Error ? error.message : "migration_operator_unknown" },
          { status: 409, headers: { "cache-control": "no-store" } });
      } finally { this.#migrationOperatorRunning = false; }
    }
    if (url.pathname === "/v1/hosted/migration/sample") {
      // Read-only digest sample for a post-routed verifier (migration-sample.ts).
      if (this.escrow) return new Response("not found", { status: 404 });
      const token = (this.env as unknown as { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN;
      const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
      const input = await migrationSampleRequest(request, token);
      if (input instanceof Response) return input;
      if (input.collection !== collection) return json(400, { error: "invalid_request" });
      this.requirePhysicalCollection(collection);
      let step: number | null;
      try { step = readNativeState(this.ctx.storage.sql).checkpoint?.step ?? null; }
      catch { return json(409, { error: "migration_state_unreadable" }); }
      if (step === null || step < STEP.verified || step > STEP.routed) return json(409, { error: "migration_not_verified" });
      try {
        const engine = await this.ready(collection);
        return json(200, migrationSampleBody(input, step, engine.migrationSample(nativeSampleRequest(input))));
      } catch { return json(503, { error: "migration_sample_unavailable" }); }
    }
    if (url.pathname === "/v1/hosted/migration/run" || url.pathname === "/v1/hosted/migration/status") {
      if (this.escrow) return new Response("not found", { status: 404 });
      const token = (this.env as unknown as { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN;
      const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
      const store = storageRunStore(this.ctx.storage);
      const status = async () => {
        let native;
        try { native = readNativeState(this.ctx.storage.sql); } catch { native = { error: "migration_state_unreadable" }; }
        return migrationStatus(await store.load(), native);
      };
      if (url.pathname.endsWith("/status")) {
        const input = await migrationStatusRequest(request, token);
        if (input instanceof Response) return input;
        if (input.collection !== collection) return json(400, { error: "invalid_request" });
        this.requirePhysicalCollection(collection);
        return json(200, await status());
      }
      const input = await migrationRunRequest(request, token);
      if (input instanceof Response) return input;
      if (input.collection !== collection) return json(400, { error: "invalid_request" });
      if (!this.migrationConfigured()) return json(503, { error: "migration_unconfigured" });
      let diagnostic: ReadyDiagnostic | undefined;
      try {
        await this.ready(collection, value => { diagnostic = value; });
      } catch (error) {
        // ready() may already have effects; 500/UNKNOWN is unchanged. No run save yet.
        return json(500, { error: "migration_run_ready_failed", ...(diagnostic ?? readyDiagnostic("unknown", error)),
          ...labRawError(this.env.LAB, error) });
      }
      try {
        const run = await store.load();
        if (run && run.backupHold !== input.backupHold) {
          if ((run.state !== "stopped" && run.state !== "done") || this.#migrationOperatorRunning) {
            return json(409, { error: "migration_run_exists", ...(await status()) });
          }
          this.#migrationOperatorRunning = true;
          try {
            await this.supersedeMigration(run, input.backupHold, input.pauseBeforeCutover, AbortSignal.timeout(60_000));
          } catch {
            // Native refused or the outcome is unknown; the stored run is unchanged
            // unless the new run record itself landed, which status shows.
            return json(409, { error: "migration_run_exists", ...(await status()) });
          } finally { this.#migrationOperatorRunning = false; }
          await this.alarms.schedule(Date.now() + 100, () => this.alarms.current);
          return json(202, await status());
        }
        if (run && run.pauseBeforeCutover !== input.pauseBeforeCutover) return json(409, { error: "migration_pause_mode_conflict", ...(await status()) });
        // A stopped run stays stopped: resuming it is an operator procedure.
        if (!run) await store.save(newRun(collection, input.backupHold, Date.now(), input.pauseBeforeCutover));
        if (!run || run.state === "running" || run.state === "waiting") {
          await this.alarms.schedule(Date.now() + 100, () => this.alarms.current);
        }
        return json(run ? 200 : 202, await status());
      } catch (error) {
        // A run write/alarm may already have landed. Preserve UNKNOWN; never retry.
        if (this.env.LAB !== "1") throw error;
        return json(500, { error: "migration_run_failed", ...labRawError(this.env.LAB, error) });
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
        if (isPermanentCustodyRefusal(error)) return verdictAnswer(error);
        throw error;
      }
      const generation = this.logGen;
      engine.refresh();
      try { await this.sync(engine); }
      catch (error) {
        // A warm engine learns of the verdict through its fresh log token (the
        // activation dropped the held one): retire as the alarm path does, and
        // give the CP the same definite answer as a cold open.
        if (!isPermanentCustodyRefusal(error)) throw error;
        await this.retireForVerdict();
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
      // Bounded ingress: sockets (including pre-prologue ones) per DO.
      const apps = this.ctx.getWebSockets().filter((w) => (w.deserializeAttachment() as AppAttachment | null)?.app).length;
      if (apps >= MAX_APP_SOCKETS) return new Response("busy", { status: 503 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ wake: this.wakeId, app: true } satisfies AppAttachment);
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
      if (this.readers.size >= MAX_APP_SESSIONS) return this.endApp(engine, ws, a, 1013, "busy");
      const h = grant ? engine.noiseStart(bytes) : 0;
      if (!grant || !h) return this.endApp(engine, ws, a, 1008, "prologue");
      this.readers.set(h, new FrameReader());
      ws.serializeAttachment({ ...a, noise: h, grant } satisfies AppAttachment);
      return;
    }
    if (a.session === undefined) {
      // 2. Noise message 1: the hello request; admitted, then answered in message 2.
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
        if (!session) return this.endApp(engine, ws, a, 1008, "refused");
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
      if (input instanceof Response) return input;
      const operation = url.pathname.endsWith("/ready") ? "ready" : "retire";
      const stub = namedStub(env.COLLECTIONS,input.collection,hint);
      const headers = new Headers(request.headers); headers.delete("content-length");
      return stub.fetch(new Request(`${url.origin}/v1/hosted/collection-mode/${operation}?collection=${input.collection}`,
        {method:"POST",headers,body:JSON.stringify(input)}));
    }
    if (url.pathname === "/internal/v1/migration-admission") {
      if (kind !== "hosted") return new Response("not found", { status: 404 });
      const input = await migrationAdmissionRequest(request, e.HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) return input;
      // A creating request may place a new actor in the collection's region.
      const stub = namedStub(env.COLLECTIONS, input.collection, input.region ?? hint);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return stub.fetch(new Request(`${url.origin}/v1/hosted/migration-admission?collection=${input.collection}`, {
        method: "POST", headers, body: JSON.stringify({ collection: input.collection, challenge: input.challenge }),
      }));
    }
    if (url.pathname === "/internal/v1/migration/operator") {
      if (kind !== "hosted") return new Response("not found", { status: 404 });
      const input = await migrationOperatorRequest(request, e.HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) return input;
      const stub = namedStub(env.COLLECTIONS, input.collection, hint);
      const headers = new Headers(request.headers); headers.delete("content-length");
      return stub.fetch(new Request(`${url.origin}/v1/hosted/migration/operator?collection=${input.collection}`,
        { method: "POST", headers, body: JSON.stringify(migrationOperatorBody(input)) }));
    }
    if (url.pathname === "/internal/v1/migration/run" || url.pathname === "/internal/v1/migration/status") {
      if (kind !== "hosted") return new Response("not found", { status: 404 });
      const run = url.pathname.endsWith("/run");
      const input = run ? await migrationRunRequest(request, e.HOSTED_SERVICE_TOKEN) : await migrationStatusRequest(request, e.HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) return input;
      const stub = namedStub(env.COLLECTIONS, input.collection, hint);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      const body = "backupHold" in input && "pauseBeforeCutover" in input ? { collection: input.collection, backup_hold: input.backupHold, stop_before_flip: input.pauseBeforeCutover } : { collection: input.collection };
      return stub.fetch(new Request(`${url.origin}/v1/hosted/migration/${run ? "run" : "status"}?collection=${input.collection}`, {
        method: "POST", headers, body: JSON.stringify(body),
      }));
    }
    if (url.pathname === "/internal/v1/migration/sample") {
      if (kind !== "hosted") return new Response("not found", { status: 404 });
      const input = await migrationSampleRequest(request, e.HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) return input;
      const stub = namedStub(env.COLLECTIONS, input.collection, hint);
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return stub.fetch(new Request(`${url.origin}/v1/hosted/migration/sample?collection=${input.collection}`, {
        method: "POST", headers, body: JSON.stringify(input),
      }));
    }
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
      const wrapper = (role === "hosted" || localBuild() ? productionWrapper(productionParts(env as unknown as FactoryEnv)) : null)
        ?? (env.LAB === "1" ? labStubWrapper(role, e.LAB_CUSTODY_WRAP_KEY) : null) ?? DENY_WRAPPER;
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
