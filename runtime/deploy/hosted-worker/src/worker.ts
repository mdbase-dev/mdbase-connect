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
import { httpsLog, pumpLog, StaleAppendStore, type CallTimings } from "./log.js";
import { DENY_ADMISSION, DENY_CUSTODY, DENY_WRAPPER, type Admission, type Custody, type OpenKeys } from "./seams.js";
import { generateServiceDevice, serviceCollection } from "./service-devices.js";
import { migrationAdmissionRequest, migrationAdmissionObservation, migrationAdmissionUnavailable } from "./migration-admission.ts";
import { generateDeviceKeys } from "./keygen.js";
import engineModule from "../hosted.wasm";
import { labCustody, labAuthorized } from "./lab.js";
import { labStubUnwrap, labStubWrapper } from "./custody-stub.js";
import { combinedCustody, cpCustody } from "./cp-custody.js";
import { ControlClient } from "./control.js";
import { ProductionCustody, deploymentRelease, productionParts, productionWrapper, type FactoryEnv } from "./factory.ts";
import { devicePublicKeys, verifyHostedGenesis } from "./keygen.js";
import { runIndex } from "./sql.js";
import { labHealth } from "./health.js";
import { fetchAttachment } from "./object-reads.js";
import { deploymentObjectOrigins, type ObjectOriginPolicy } from "./object-origins.ts";
import { hasGrantAppend, wakeCollectionTag, wakeLog } from "./wake-observe.ts";
import { LiveAdmission, type AdmissionContext } from "./admission/live-admission.ts";
import { FrameReader, MAX_APP_BUFFERED, MAX_APP_SESSIONS, MAX_APP_SOCKETS, evidence, frameChunks, parsePrologue, uuidString } from "./app.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
/** Socket-independent hosted polling fallback; committed CP policy also wakes it. */
const REFRESH_MS = 30_000;
/** The escrow learns of new enrolments at least this often (no push from the log). */
const ESCROW_POLL_MS = 60_000;
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

export class HostedCollection extends DurableObject<Env> {
  private engine: Engine | null = null;
  private attachmentPermit: { engine: Engine; session: number; permit: ChunkPermit } | null = null;
  private attachmentWaiters = new Map<AbortController, { engine: Engine; session: number }>();
  private opening: Promise<Engine> | null = null;
  private background: AlarmLifecycle | null = null;
  private get alarms(): AlarmLifecycle {
    return this.background ??= new AlarmLifecycle(this.ctx.storage);
  }
  private async requireBackground(): Promise<void> {
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
  /** Phase timings of this wake's first open (LAB status only). */
  private timings: Record<string, unknown> | null = null;
  /** When this DO instance (wake) started. */
  private readonly wokeAt = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.objectOrigins = deploymentObjectOrigins(env as Env & { OBJECT_STORAGE_ORIGINS?: string });
    const lab = env.LAB === "1";
    const e = env as unknown as {
      SERVICE_KIND?: string; CP_URL?: string; CP_INBOUND_TOKEN?: string; CP_ROOTS?: string;
      LAB_CUSTODY_WRAP_KEY?: string; LAB_HOSTED_CONFIG?: string;
    };
    this.escrow = e.SERVICE_KIND === "escrow";
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
      ? new ProductionCustody(parts, () => this.replicaId(), (secret) => devicePublicKeys(engineModule, secret), verifyOriginal)
      : null;
    this.custody = this.production ?? (lab ? combinedCustody(labCustody(env, (secret) => devicePublicKeys(engineModule, secret), verifyOriginal), inFixture, cp) : DENY_CUSTODY);
    this.admission = DENY_ADMISSION;
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
    return !!this.live && this.live.engine === engine && this.engine === engine &&
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

  /** Open (or return) the engine for this wake, rebuilt from the log. */
  private async ready(collection: string): Promise<Engine> {
    await this.requireBackground();
    if (this.collection && this.collection !== collection) throw new Error("collection mismatch");
    this.collection = collection;
    // Both service roles must reopen after eviction without an app socket.
    await this.ctx.storage.put("service-collection", collection);
    if (!this.alarms.current) throw new Error("hosted_alarm_inhibited");
    // Persist a retry before custody/network work; failed first-open must not
    // leave a registered service device without an alarm.
    if (!this.engine) {
      await this.alarms.schedule(Date.now() + REFRESH_MS, () => !this.engine);
    }
    if (!this.alarms.current) throw new Error("hosted_alarm_inhibited");
    if (this.engine) return this.engine;
    this.opening ??= (async () => {
      // First open of this wake: phase timings for the LAB status (Workers clocks
      // advance only across I/O, so CPU-only phases can read 0 ms).
      const t0 = Date.now();
      const calls: CallTimings = new Map();
      const keys = await this.custody.openSealer(collection, AbortSignal.timeout(10_000));
      const tKeys = Date.now();
      let engine: Engine;
      let tWasm: number;
      let app: { device: string; publicKeys: NonNullable<typeof keys.publicKeys>; roots: Uint8Array[] } | null = null;
      try {
        await this.requireBackground();
        engine = new Engine(this.ctx.storage);
        tWasm = Date.now();
        engine.open(openConfig(collection, keys, this.escrow));
        // App sessions (hosted only): the Noise static secret moves into the
        // engine's RAM for this wake; the JS copy is wiped with the rest.
        if (!this.escrow && keys.noiseSk && keys.publicKeys && engine.noiseKey(keys.noiseSk.slice())) {
          app = { device: keys.deviceId, publicKeys: keys.publicKeys, roots: keys.roots.map((r) => r.slice()) };
        }
      } finally {
        keys.zeroize();
      }
      const live = app ? await this.liveAdmission(engine, collection, app) : null;
      await this.requireBackground();
      this.live = live;
      const tOpen = Date.now();
      this.engine = engine;
      await this.sync(engine, calls);
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
      if (engine.needsReset()) {
        // The cache disagrees with the log: drop every store table and rebuild.
        this.releaseAttachment(engine);
        this.logGen++;
        this.engine = null;
        this.live = null;
        for (const r of this.readers.values()) r.wipe();
        this.readers.clear();
        runIndex(this.ctx.storage, RESET);
        throw new Error("hosted cache reset; retry");
      }
      return engine;
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** The log: the `LOG` service binding, or (`LOG_URL`) its public https origin
   * when the log Worker lives in another account. */
  private log(): Fetcher {
    const url = (this.env as unknown as { LOG_URL?: string }).LOG_URL;
    return url ? httpsLog(url) : this.env.LOG;
  }

  private token = () => this.custody.logToken(this.collection!, AbortSignal.timeout(10_000));

  /** Move log traffic until quiet, deliver output, schedule the next wakeup. */
  private async sync(engine: Engine, timings?: CallTimings): Promise<void> {
    const gen = this.logGen;
    const current = () => this.alarms.current && this.logGen === gen && this.engine === engine;
    if (!await this.alarms.allowed() || !current()) return;
    const tag = this.env.LAB === "1" && this.collection ? await wakeCollectionTag(this.collection) : null;
    if (!current()) return;
    await pumpLog(this.log(), engine, this.token, current, this.staleAppends, 64, timings, tag ? (call) => {
      if (current() && hasGrantAppend(call.frame)) wakeLog(tag, this.escrow ? "escrow" : "hosted", "grant_emitted");
    } : undefined, tag ? (call, observation) => {
      if (current() && hasGrantAppend(call.frame)) wakeLog(tag, this.escrow ? "escrow" : "hosted", "grant_append_outcome", observation);
    } : undefined);
    if (!current()) return;
    this.pruneAttachment();
    this.deliver(engine); // read_file response precedes object/network waits
    if (!this.escrow) {
      // At most manifest + one complete chunk. The engine refuses a second
      // ciphertext slot while its owned plaintext chunk still needs draining.
      for (let i = 0; i < 2 && current(); i++) {
        const read = engine.attachmentObject();
        if (!read) break;
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
        this.deliver(engine);
      }
    }
    if (!current()) return;
    this.pruneAttachment();
    const next = engine.nextWakeup();
    const poll = Date.now() + (this.escrow ? ESCROW_POLL_MS : REFRESH_MS);
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
    const ws = this.ctx.getWebSockets().find((ws) => {
      const a = ws.deserializeAttachment() as AppAttachment | null;
      return ws.readyState === 1 && a?.wake === this.wakeId && a.session === session;
    });
    if (!ws) return false;
    const a = ws.deserializeAttachment() as AppAttachment;
    if (!a.app) return this.env.LAB === "1"; // existing authenticated LAB-only admin socket
    return !!a.noise && this.admitted(engine, { collection: this.collection!, op: "call", grant: a.grant, clientPk: fromHex(a.client ?? "") });
  }

  private deliver(engine: Engine): void {
    const bySession = new Map<number, WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { session?: number; wake?: string } | null;
      if (a?.session !== undefined && a.wake === this.wakeId) bySession.set(a.session, ws);
    }
    for (const o of engine.poll()) {
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
  }

  /** Distinguishes sockets accepted in this wake from older ones (RAM state gone). */
  private readonly wakeId = crypto.randomUUID();

  async alarm(): Promise<void> {
    if (!await this.alarms.allowed()) {
      await this.alarms.inhibit();
      return;
    }
    if (!this.engine) {
      // Keep the old escrow key readable for existing enrolled DOs.
      const collection = await this.ctx.storage.get<string>("service-collection")
        ?? (this.escrow ? await this.ctx.storage.get<string>("escrow-collection") : undefined);
      if (collection && UUID.test(collection)) await this.ready(collection);
    }
    if (!await this.alarms.allowed() || !this.engine || !this.collection) return;
    const engine = this.engine;
    engine.tick(Date.now());
    if (this.escrow || Date.now() - this.lastRefresh >= REFRESH_MS) {
      this.lastRefresh = Date.now();
      engine.refresh();
    }
    await this.sync(engine);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const collection = url.searchParams.get("collection") ?? "";
    if (!UUID.test(collection)) return new Response("bad collection", { status: 400 });
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
    if (url.pathname === "/v1/hosted/activate") {
      const approved = await serviceCollection(request, (this.env as unknown as { HOSTED_SERVICE_TOKEN?: string }).HOSTED_SERVICE_TOKEN);
      if (approved instanceof Response) return approved;
      if (approved !== collection) return new Response("bad collection", { status: 400 });
      const tag = this.env.LAB === "1" ? await wakeCollectionTag(collection) : null;
      if (tag) wakeLog(tag, this.escrow ? "escrow" : "hosted", "wake_received");
      const engine = await this.ready(collection);
      const generation = this.logGen;
      engine.refresh();
      await this.sync(engine);
      if (tag && this.engine === engine && this.logGen === generation) wakeLog(tag, this.escrow ? "escrow" : "hosted", "activation_complete");
      return Response.json({ activated: true }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname.endsWith("/app") && !this.escrow && request.headers.get("upgrade") === "websocket") {
      // App sessions: Noise authenticates; live admission decides each step.
      const engine = await this.ready(collection);
      if (!this.live) return new Response("not available", { status: 503 });
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
    const a = ws.deserializeAttachment() as AppAttachment | null;
    const engine = this.engine;
    if (!engine || !a || a.wake !== this.wakeId) {
      // Accepted before this wake: the session's state is gone. Re-handshake.
      ws.close(1012, "rehandshake");
      return;
    }
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

  async webSocketClose(ws: WebSocket): Promise<void> {
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
    const health = labHealth(request, env.LAB === "1");
    if (health) return health;
    const url = new URL(request.url);
    const e = env as unknown as { HOSTED_SERVICE_TOKEN?: string; SERVICE_KIND?: string; LAB_CUSTODY_WRAP_KEY?: string };
    const kind = e.SERVICE_KIND === "escrow" ? "escrow" : "hosted";
    if (url.pathname === "/internal/v1/migration-admission") {
      if (kind !== "hosted") return new Response("not found", { status: 404 });
      const input = await migrationAdmissionRequest(request, e.HOSTED_SERVICE_TOKEN);
      if (input instanceof Response) return input;
      const stub = env.COLLECTIONS.get(env.COLLECTIONS.idFromName(input.collection));
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      return stub.fetch(new Request(`${url.origin}/v1/hosted/migration-admission?collection=${input.collection}`, {
        method: "POST", headers, body: JSON.stringify(input),
      }));
    }
    if (url.pathname === "/internal/v1/collections/activate") {
      const collection = await serviceCollection(request, e.HOSTED_SERVICE_TOKEN);
      if (collection instanceof Response) return collection;
      const stub = env.COLLECTIONS.get(env.COLLECTIONS.idFromName(collection));
      return stub.fetch(new Request(`${url.origin}/v1/hosted/activate?collection=${collection}`, {
        method: "POST", headers: request.headers, body: JSON.stringify({ collection }),
      }));
    }
    if (url.pathname === "/internal/v1/service-devices") {
      // The control plane's cloud-copy bootstrap. Denied until KMS custody is
      // installed; LAB may use the custody stub (LAB_CUSTODY_WRAP_KEY).
      const wrapper = (kind === "hosted" ? productionWrapper(productionParts(env as unknown as FactoryEnv)) : null)
        ?? (env.LAB === "1" ? labStubWrapper(kind, e.LAB_CUSTODY_WRAP_KEY) : null) ?? DENY_WRAPPER;
      return generateServiceDevice(request, { serviceToken: e.HOSTED_SERVICE_TOKEN, generate: () => generateDeviceKeys(engineModule), wrapper, kind });
    }
    const collection = url.searchParams.get("collection") ?? "";
    if (!url.pathname.startsWith("/v1/hosted/") || !UUID.test(collection)) {
      return new Response("not found", { status: 404 });
    }
    const stub = env.COLLECTIONS.get(env.COLLECTIONS.idFromName(collection));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
