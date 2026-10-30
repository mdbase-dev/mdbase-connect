/** Concrete protected native collection composition. Runs in the original owned
 * Worker. One UI data client, SDK-owned journal/control, no duplicate leases or
 * app-private installation controller. Native host retains SQL close LAST. */
import { appServerOutcome, isAppServerProblem, type AppServerProblem } from "./cp-problem.js";
import { AppCpAuthorityError } from "./cp-authority.js";
import { waitForOpenRetry } from "./open-wait.js";
import type { AppLogHealth } from "./log-pump.js";
import type { AppLogPushChannel, AppLogPushEnd } from "./log-push.js";
import type { AppInitialSyncWait } from "./initial-sync.js";
import { MdbaseClient, type ClientOptions } from "../client.js";
import { TimersApi } from "../timers.js";
import { appTimerPortClient } from "./timer-port.js";
import { createAppCollectionSql, type AppCollectionSqlOptions, type AppLedgerRows } from "../app-storage/collection-sql.js";
import { AppCollectionJoinLedger } from "./collection-join-ledger.js";
import { AppCollectionSetupJournal, type AppCollectionSetupJournalOptions } from "./collection-setup-journal.js";
import { attachAppCollectionControl, appCollectionControlClient, type AppCollectionControlClient, type AppResourceSetupPort } from "./collection-control.js";
import { appLocalConnector, type AppLocalConnector } from "./local-facade.js";
import type { AppReplicaScope } from "./owner.js";
import type { AppWebSignInSessionOptions, AppWebCollectionConnection } from "./web-sign-in-session.js";
import type { ModelResourceSetupJournal } from "./collection-setup-types.js";
import { createAppCollectionPeople } from "./collection-people.js";
import type { MdbasePeopleClient } from "../people.js";

/** A push socket down this long shows as "live updates paused". */
const PAUSED_AFTER_MS = 10_000;
/** How long a hidden session keeps sending pending writes. */
const BACKGROUND_FLUSH_MS = 120_000;
/** A replica that caught up before waits at most this long for a fresh catch-up. */
const WARM_SYNC_MS = 2_000;
/** Only initial log-token busy refusals may schedule these SAME-host retries.
 * Individual challenge/mint calls retain their existing 15 s HTTP deadlines. */
const INITIAL_LOG_RETRY_MS = 15_000;
const INITIAL_LOG_ATTEMPTS = 3;

export interface AppWebCollectionHandoff {
  readonly schema: "mdbn-app-collection/1";
  readonly scope: Readonly<AppReplicaScope>;
  readonly generation: string;
  readonly displayName: string;
  /** Never authorizes submit by itself; UI semantic engine verifies exact plans,
   * receipts/resources/sources. Absent/PREPARED on restore is inspect ONLY. */
  readonly setupMode: "inspect" | "approved-new" | "reconcile-original";
  readonly dataPort: MessagePort;
  readonly controlPort: MessagePort;
  /** SDK-configured metadata authority on SAME control channel; not consent. */
  readonly people?: true;
  /** Present only for the original chosen native reminder consent. */
  readonly timerPort?: MessagePort;
}
export interface AppWebNativeCollection {
  readonly scope: Readonly<AppReplicaScope>;
  readonly generation: string;
  isCurrent(): boolean;
  setForeground(active: boolean): void;
  /** Another tab of this app joined: its own data, control and timer ports onto
   * the SAME replica. Null once closed or at the attach limit. */
  attach?(): AppWebCollectionHandoff | null;
  /** That tab left: close its ports. The replica and other tabs stay open. */
  detach?(handoff: AppWebCollectionHandoff): void;
}
export interface AppWebCollectionAdapterOptions {
  readonly joinDatabaseName: string;
  readonly setupJournal: Omit<AppCollectionSetupJournalOptions, "scope" | "isCurrent">;
  readonly sql: AppCollectionSqlOptions;
  /** SDK declaration/authority projection. Never authorizes optional access. */
  readonly people?: boolean;
  /** Deliver required data/control and any optional timer port once, transferring
   * ALL present ports to UI. Host, native runtime, SQL, ciphertext, keys and
   * credentials never leave Worker. */
  handoff(value: AppWebCollectionHandoff): void;
  readonly fetch?: typeof fetch;
  readonly allowLoopbackHttp?: boolean;
}
export class AppWebCollectionError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "unavailable") {
    super(`app web collection: ${reason}`); this.name = "AppWebCollectionError";
  }
}
const fail = (reason: AppWebCollectionError["reason"]) => new AppWebCollectionError(reason);

/** Suitable directly for AppWebSignInSession.openCollection. Required frozen
 * result remains state/connection/close; subscribe is optional assessment push. */
export function createAppWebCollectionAdapter(source: AppWebCollectionAdapterOptions): AppWebSignInSessionOptions<AppWebNativeCollection>["openCollection"] {
  const options = Object.freeze({...source, setupJournal: Object.freeze({...source.setupJournal})});
  const openSql = createAppCollectionSql(options.sql);
  if (typeof options.handoff !== "function") throw fail("binding");
  // One open adapter per collection; several collections may be open at once
  // (each page of the app shows its own).
  const occupied = new Set<string>();
  return async context => {
    const slot = JSON.stringify([context.scope.account, context.scope.installation, context.scope.collection]);
    if (occupied.has(slot)) throw fail("fenced"); occupied.add(slot);
    const {host, installation: custody, signal: parentSignal, collection, setupPolicy} = context;
    const ownership = custody.isCurrent, displayName = collection.displayName;
    const report = (stage: import("./opening-progress.js").AppOpeningProgress) => {
      if (!current()) return;
      try { context.onProgress?.(stage); } catch { /* display observers do not own opening */ }
    };
    const scope = Object.freeze({account: context.scope.account, installation: context.scope.installation, collection: context.scope.collection});
    const original = JSON.stringify([scope.account, scope.installation, scope.collection]), life = new AbortController();
    let closed = false, foreground = true, timer: ReturnType<typeof setTimeout> | null = null;
    let driving: Promise<void> | null = null, closing: Promise<void> | null = null;
    let control: ReturnType<typeof attachAppCollectionControl> | null = null;
    let timers: ReturnType<typeof host.openTimersPort> = null;
    let journal: AppCollectionSetupJournal | null = null, data: MessageChannel | null = null, command: MessageChannel | null = null;
    let assessment: "ready" | "setup_required" = "setup_required";
    let push: AppLogPushChannel | null = null, paused = false, pausing: ReturnType<typeof setTimeout> | null = null, kicked = false;
    /** Access ended on the log (removed, device revoked, collection gone). Terminal. */
    let ended: AppLogPushEnd | null = null;
    /** Tabs attached after the first: their ports, closed with the connection. */
    const attached = new Map<MessagePort, {data: MessageChannel; command: MessageChannel; control: ReturnType<typeof attachAppCollectionControl>; timers: ReturnType<typeof host.openTimersPort>}>();
    let problem: AppServerProblem | null = null;
    const listeners = new Set<() => void>();
    const current = () => {
      try {return !closed && !life.signal.aborted && !parentSignal.aborted && context.signal === parentSignal && context.host === host &&
        context.installation === custody && custody.isCurrent === ownership && ownership.call(custody) === true && context.collection === collection && context.setupPolicy === setupPolicy &&
        custody.scope.account === scope.account && custody.scope.installation === scope.installation &&
        JSON.stringify([context.scope.account, context.scope.installation, context.scope.collection]) === original && collection.collectionId === scope.collection;}
      catch {return false;}
    };
    const check = () => {if (!current()) throw fail("fenced");};
    const changed = () => { for (const listener of [...listeners]) {try {listener();} catch { /* display observer cannot interrupt ownership */ }} };
    const close = () => {
      if (closing) return closing;
      closed = true; assessment = "setup_required";
      if (timer !== null) clearTimeout(timer); timer = null;
      if (pausing !== null) clearTimeout(pausing); pausing = null;
      try {push?.close();} catch { /* socket close is best effort */ } push = null;
      try {host.onLogWork?.(null);} catch { /* closed with the host */ }
      parentSignal.removeEventListener("abort", abort);
      const others = [...attached.values()]; attached.clear();
      closing = Promise.resolve().then(async () => {
        let failed = false;
        try {await timers?.close();} catch {failed = true;}
        try {await control?.close();} catch {failed = true;}
        for (const other of others) {
          try {await other.timers?.close();} catch {failed = true;}
          try {await other.control.close();} catch {failed = true;}
          try {other.data.port1.postMessage([1, JSON.stringify([scope.account, scope.installation, scope.collection]), "close"]);} catch {failed = true;}
          for (const port of [other.data.port1, other.data.port2, other.command.port1, other.command.port2]) {
            try {port.close();} catch {failed = true;}
          }
        }
        // Notify UI data client before fencing native/SQL; appLocalConnector
        // rejects its hello/RPC/read waiters on this exact original scope.
        try {data?.port1.postMessage([1, JSON.stringify([scope.account, scope.installation, scope.collection]), "close"]);} catch {failed = true;}
        for (const port of [data?.port1, data?.port2, command?.port1, command?.port2]) {
          try {port?.close();} catch {failed = true;}
        }
        await driving?.catch(() => {});
        try {journal?.close();} catch {failed = true;}
        if (failed) throw fail("unavailable");
        listeners.clear(); occupied.delete(slot);
      });
      life.abort(); changed(); return closing;
    };
    const abort = () => {void close().catch(() => {});};
    let health: AppLogHealth | null = null;
    // A live server refusal slows the drive: the server's retry delay while
    // migrating (5 s..10 min), else 5 min. It clears on the next accepted reply.
    // A busy or rate-limiting log is retried after its Retry-After, else with
    // backoff; offline waits for an online, focus or visibility event.
    let unhealthy = 0;
    const delay = (): number | null => {
      const outcome = appServerOutcome(problem);
      if (outcome !== null) return outcome === "collection_migrating" ? Math.min(600_000, Math.max(5_000, problem?.retryAfterMs ?? 30_000)) : 300_000;
      const backoff = Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(unhealthy, failures), 6));
      // Before the first catch-up no tab can deliver an online event yet.
      if (health?.kind === "offline") return settleInitial ? backoff : null;
      if (health?.kind === "server_busy" || health?.kind === "rate_limited") return health.retryAfterMs ?? backoff;
      return failures || health ? backoff : 250;
    };
    const observe = () => {
      let next: AppServerProblem | null = null; try { next = host.serverProblem(); } catch { next = null; }
      let nextHealth: AppLogHealth | null = null; try { nextHealth = host.transportHealth(); } catch { nextHealth = null; }
      unhealthy = nextHealth ? unhealthy + 1 : 0;
      const same = JSON.stringify(nextHealth) === JSON.stringify(health);
      if (next !== problem || !same) { problem = next; health = nextHealth; changed(); }
    };
    // Other devices' entries arrive on the log's push socket, which drives at once.
    // Nothing polls the log: without a live socket (older runtime, socket down),
    // a head wake runs only on events (visible, focus, online) and never on a timer.
    // Once hidden, only drives run, and only while local writes are pending, for
    // at most two minutes after the session was hidden.
    let wakeAt = Number.POSITIVE_INFINITY, failures = 0, hiddenAt = 0;
    /** A log turn succeeded since this open; set before the first catch-up check. */
    let turned = false;
    /** Re-checks the first catch-up while the open waits for it. */
    let settleInitial: (() => void) | null = null;
    // Typed reasons for failed turns, so a slow first sync can be diagnosed
    // from the console (debug level) without reading the replica.
    const turnFailed = (error: unknown) => {
      const code = error && typeof error === "object" && typeof (error as {code?: unknown}).code === "string" ? (error as {code: string}).code : null;
      try { console.debug("mdbase: sync turn failed", {reason: health?.kind ?? appServerOutcome(problem) ?? code ?? "unknown", failures}); } catch { /* console is optional */ }
    };
    const flushing = () => {
      if (foreground) return false;
      if (Date.now() - hiddenAt >= BACKGROUND_FLUSH_MS) return false;
      try { return host.pendingWrites() > 0; } catch { return false; }
    };
    const schedule = () => {
      if (!current()) return;
      // Hidden with nothing left to send: close the socket; showing reconnects.
      if (!foreground && !flushing() && !kicked) { if (!driving) push?.suspend(); return; }
      if (timer !== null || driving) return;
      const wait = kicked ? 0 : delay();
      kicked = false;
      if (wait === null) return;
      timer = setTimeout(() => {
        timer = null; if (!current()) return;
        const wake = foreground && Date.now() >= wakeAt;
        if (wake) wakeAt = Number.POSITIVE_INFINITY;
        const work = driving = wake ? host.wakeCollectionLog({signal: life.signal}) : host.driveCollection({signal: life.signal});
        void work.then(() => {if (driving === work) driving = null; failures = 0; turned = true; if (current()) observe(); settleInitial?.(); schedule();},
          // A failed turn (offline token mint, transient fence) backs off and
          // retries; it never silently ends remote-change delivery for the session.
          error => {if (driving === work) driving = null; failures++; if (current()) observe(); turnFailed(error); settleInitial?.(); schedule();});
      }, wait);
    };
    // Visible (or an online/focus event while visible): wake at once and forget
    // backoff. Hidden: start the bounded background flush.
    // A push: the replica took the frame; drive now (reads for a `head`, acks).
    const kick = () => {
      if (!current()) return;
      kicked = true; if (timer !== null) clearTimeout(timer); timer = null; schedule();
    };
    const setPaused = (next: boolean) => { if (paused !== next) { paused = next; changed(); } };
    const onLive = (live: boolean) => {
      if (pausing !== null) clearTimeout(pausing); pausing = null;
      if (live) { setPaused(false); return; }
      if (!push?.available) { setPaused(ended === null); return; }
      // Closed on purpose while hidden: not paused, nobody is looking.
      if (push.suspended) return;
      pausing = setTimeout(() => { pausing = null; if (current() && !push?.live) setPaused(true); }, PAUSED_AFTER_MS);
    };
    const setForeground = (active: boolean) => {
      check();
      if (active) {
        if (!push?.live || health?.kind === "offline") wakeAt = 0;
        failures = 0; unhealthy = 0;
        // Online is a wake, not evidence that the original transport recovered.
        // Keep its known failure until observe() sees an accepted reply, so
        // subscribers hear the health transition as well as getter readers.
        if (health?.kind === "offline") kicked = true;
        try {push?.resume(); if (push && !push.live) onLive(false);} catch { /* reconnect is best effort */ }
      }
      else if (foreground) hiddenAt = Date.now();
      foreground = active; if (timer !== null) clearTimeout(timer); timer = null; schedule();
    };
    // Cold catch-up is driven/guarded inside waitForVerifiedRead. A previously
    // synced local replica keeps the existing brief, offline-capable warm wait.
    const waitForWarmSync = () => new Promise<void>((resolve, reject) => {
      let last: string | undefined, bound: ReturnType<typeof setTimeout> | null = null;
      const finish = (error?: unknown) => {
        settleInitial = null; if (bound !== null) clearTimeout(bound);
        life.signal.removeEventListener("abort", stop);
        if (error) reject(error); else resolve();
      };
      const stop = () => finish(fail("fenced"));
      life.signal.addEventListener("abort", stop, {once: true});
      settleInitial = () => {
        if (!current()) { finish(fail("fenced")); return; }
        if (ended !== null) { finish(); return; }
        let wait: AppInitialSyncWait | null = "first_turn";
        if (turned) { try { wait = typeof host.initialSync === "function" ? host.initialSync() : null; } catch { wait = "unavailable"; } }
        if (wait === null || wait === "offline" || health?.kind === "offline") { finish(); return; }
        let detail: Record<string, string | number> | null = null;
        if (wait === "waiting_for_key" && typeof host.keyWaitDetail === "function") { try { detail = host.keyWaitDetail(); } catch { detail = null; } }
        const shown = wait + (detail ? JSON.stringify(detail) : "");
        if (shown !== last) {
          last = shown;
          try { console.debug("mdbase: waiting for the first sync", {...detail, reason: wait}); } catch { /* console is optional */ }
        }
      };
      bound = setTimeout(() => finish(), WARM_SYNC_MS);
      settleInitial();
    });
    parentSignal.addEventListener("abort", abort, {once: true});
    try {
      check();
      journal = new AppCollectionSetupJournal({...options.setupJournal, scope, isCurrent: current}); // validate BUILD config before bootstrap IO
      const ledger = new AppCollectionJoinLedger({databaseName: options.joinDatabaseName, scope, isCurrent: current});
      const attempt = await ledger.prepare({signal: life.signal}); check();
      report("joining");
      await host.bootstrapCloudCopy({scope, collectionCurrent: current, purpose: "join", outcomeMode: attempt.outcomeMode,
        signal: life.signal, ...(attempt.outcomeMode === "existing" ? {reconcile: "explicit-unknown-outcome" as const} : {}),
        fetch: options.fetch, allowLoopbackHttp: options.allowLoopbackHttp}); check();
      await ledger.complete({signal: life.signal}); check();
      const receipt = host.registeredReceipt();
      if (receipt.installationId !== scope.installation) throw fail("binding");
      let ledgerRows: AppLedgerRows | null = null;
      const openLedgerSql: typeof openSql = async input => { const opened = await openSql(input); ledgerRows = opened.ledger ?? null; return opened; };
      report("opening_store");
      await host.openCollectionSql({signal: life.signal, replicaId: receipt.deviceId, endpoint: 0, openSql: openLedgerSql}); check();
      report("connecting_log");
      const retryUntil = Date.now() + INITIAL_LOG_RETRY_MS;
      for (let attempt = 0; ; attempt++) {
        try {
          await host.startCollectionLog({signal: life.signal, fetch: options.fetch, allowLoopbackHttp: options.allowLoopbackHttp});
          check(); break;
        } catch (error) {
          check();
          const server = error instanceof AppCpAuthorityError && error.reason === "unavailable" ? error.server : null;
          // The public unavailable key alone proves nothing: auth, identity,
          // unknown 409s, storage and malformed responses must not loop.
          if (!isAppServerProblem(server) || server.status !== 503 || server.code !== "busy" || appServerOutcome(server) !== null || attempt + 1 >= INITIAL_LOG_ATTEMPTS) throw error;
          const wait = server.retryAfterMs ?? 1_000 * 2 ** attempt;
          // Never shorten a server-directed wait to fit the retry window.
          if (Date.now() + wait >= retryUntil) throw error;
          await waitForOpenRetry(wait, life.signal); check();
          if (Date.now() >= retryUntil) throw error;
          // startCollectionLog retains this host/authority/SQL. A failed mint
          // kept no token; accessToken obtains a NEW challenge and proof.
        }
      }
      const warm = await ledger.syncedBefore({signal: life.signal}); check();
      report("syncing");
      await host.waitForVerifiedRead({signal: life.signal, cold: !warm, onProgress: report}); check();
      // Drive the log now: the first catch-up below needs it, and a write or
      // file transfer drives the log at once rather than on the next turn.
      host.onLogWork?.(kick);
      schedule();
      try {
        push = typeof host.openLogPush === "function" ? host.openLogPush({
          push: frame => { if (!current()) return; host.pushLog(frame); kick(); },
          live: onLive,
          // Access ended: the replica has the `closed` push; drive so it
          // settles, then the session stops this collection in every tab.
          ended: reason => { ended = reason; kick(); onLive(false); settleInitial?.(); changed(); },
        }) : null;
      } catch { push = null; }
      // Not live within PAUSED_AFTER_MS of starting (a blocked or hung socket)
      // reads as paused, as a lost one does.
      if (push) {push.start(); onLive(false);} else paused = true;
      if (warm) { report("syncing"); await waitForWarmSync(); } check();
      report("checking_setup");
      void ledger.markSynced({signal: life.signal}).catch(() => {});
      const intent = await journal.load(life.signal); check();
      const setupMode = intent && intent.version !== 1 && (intent.phase === "attempted" || intent.phase === "confirmed") ? "reconcile-original" :
        intent === null && setupPolicy === "approved-new-collection" ? "approved-new" : "inspect";
      const generation = crypto.randomUUID();
      const people = options.people === true ? {people: true as const} : {};
      // Each tab: a data facade on its data port, and a control on its control port.
      // One setup turn across the tabs: a tab never races another tab's setup steps.
      const setupTurn = {owner: null};
      const controlFor = (dataPort: MessagePort, port: MessagePort, foreground: (active: boolean) => void, failed: () => void) =>
        attachAppCollectionControl(port, {scope, generation}, {journal: journal!, resourceSetup: host.attachDataFacade(dataPort), signal: life.signal, isCurrent: current, ledger: () => current() ? ledgerRows : null, setupTurn,
          assess(state) {check(); assessment = state; changed();}, foreground, onProtocolFailure: failed,
          ...(options.people === true ? {peopleAuthority: host.peopleAuthority()} : {})});
      timers = host.openTimersPort({scope,generation,signal:life.signal}); check();
      data = new MessageChannel(); command = new MessageChannel();
      control = controlFor(data.port1, command.port1, setForeground, abort); check();
      const detach = (handoff: AppWebCollectionHandoff) => {
        if (data && command && handoff.dataPort === data.port2) {
          // The tab that opened it left while another tab still shows it: its
          // data facade (subscriptions and pushes), control and timer port go
          // now, not when the collection closes.
          const own = {data, command, control, timers};
          data = null; command = null; control = null; timers = null;
          try {host.detachDataFacade(own.data.port1);} catch { /* closed with the host */ }
          void own.timers?.close().catch(() => {});
          void own.control?.close().catch(() => {});
          for (const port of [own.data.port1, own.command.port1]) {try {port.close();} catch { /* already closed */ }}
          return;
        }
        const other = attached.get(handoff.dataPort);
        if (!other) return;
        attached.delete(handoff.dataPort);
        try {host.detachDataFacade(other.data.port1);} catch { /* closed with the host */ }
        void other.timers?.close().catch(() => {});
        void other.control.close().catch(() => {});
        for (const port of [other.data.port1, other.command.port1]) {try {port.close();} catch { /* already closed */ }}
      };
      const attach = (): AppWebCollectionHandoff | null => {
        if (!current() || ended !== null) return null;
        const d = new MessageChannel(), c = new MessageChannel();
        let t: ReturnType<typeof host.openTimersPort> = null, ctl: ReturnType<typeof attachAppCollectionControl> | null = null;
        try {
          t = host.openTimersPort({scope, generation, signal: life.signal});
          let value: AppWebCollectionHandoff | null = null;
          // A follower's protocol failure detaches that tab only. Visibility is
          // the Worker host's, across tabs; a tab's control cannot set it.
          ctl = controlFor(d.port1, c.port1, () => {}, () => { if (value) detach(value); });
          // A follower never auto-applies setup; it may still apply explicitly.
          value = Object.freeze({schema: "mdbn-app-collection/1" as const, scope, generation, displayName,
            setupMode: setupMode === "reconcile-original" ? setupMode : "inspect" as const, dataPort: d.port2, controlPort: c.port2,
            ...people, ...(t ? {timerPort: t.port} : {})});
          attached.set(d.port2, {data: d, command: c, control: ctl, timers: t});
          return value;
        } catch {
          try {host.detachDataFacade(d.port1);} catch { /* not attached */ }
          void t?.close().catch(() => {}); void ctl?.close().catch(() => {});
          for (const port of [d.port1, d.port2, c.port1, c.port2]) port.close();
          return null;
        }
      };
      const connection: AppWebNativeCollection = Object.freeze({scope, generation, isCurrent: current, setForeground, attach, detach});
      const result: AppWebCollectionConnection<AppWebNativeCollection> = {
        get state() {return current() ? assessment : "setup_required";},
        get problem() {return current() ? problem : null;},
        get health() {return current() ? health : null;},
        get live() {return current() ? !paused : null;},
        get ended() {return current() ? ended : null;}, connection, close,
        subscribe(listener) {check(); listeners.add(listener); return () => {listeners.delete(listener);};},
      };
      options.handoff(Object.freeze({schema: "mdbn-app-collection/1", scope, generation, displayName, setupMode, dataPort: data.port2, controlPort: command.port2,
        ...people, ...(timers ? {timerPort:timers.port} : {})}));
      check(); schedule();
      return Object.freeze(result);
    } catch (error) {await close(); throw error;}
  };
}

const used = new WeakSet<MessagePort>();
export interface AppWebCollectionClient {
  /** SDK-private scoped Core resource planner; not an app constructor hook. */
  readonly resourceSetup: AppResourceSetupPort;
  readonly client: MdbaseClient;
  readonly people?: MdbasePeopleClient;
  readonly journal: ModelResourceSetupJournal;
  readonly timers?: TimersApi;
  readonly scope: Readonly<AppReplicaScope>;
  readonly setupMode: AppWebCollectionHandoff["setupMode"];
  assess(state: "ready" | "setup_required", signal: AbortSignal): Promise<void>;
  setForeground(active: boolean, signal: AbortSignal): Promise<void>;
  close(): void;
}
/** UI composition: owns the sole public data MdbaseClient and journal proxy.
 * Call assess only after the app's actual same-scope semantic setup assessment.
 * Recovery is bounded UI READ work, not a long Worker control RPC/timer/queue. */
export async function openAppWebCollectionClient(handoff: AppWebCollectionHandoff, options: {
  app: ClientOptions["app"]; signal: AbortSignal;
  /** The app's declared timer criteria: the default for channel registrations. */
  timerCriteria?: readonly string[];
}): Promise<AppWebCollectionClient> {
  if (handoff.schema !== "mdbn-app-collection/1" || used.has(handoff.dataPort) || used.has(handoff.controlPort) || handoff.dataPort === handoff.controlPort ||
    !["inspect", "approved-new", "reconcile-original"].includes(handoff.setupMode) || (handoff.people !== undefined && handoff.people !== true) || options.signal.aborted) throw fail("binding");
  if(handoff.timerPort && (used.has(handoff.timerPort) || handoff.timerPort===handoff.dataPort || handoff.timerPort===handoff.controlPort)) throw fail("binding");
  used.add(handoff.dataPort); used.add(handoff.controlPort); if(handoff.timerPort)used.add(handoff.timerPort);
  const scope = Object.freeze({...handoff.scope}), generation = handoff.generation, setupMode = handoff.setupMode, peopleEnabled = handoff.people === true;
  const dataPort = handoff.dataPort, controlPort = handoff.controlPort, signal = options.signal;
  let stopped = false, client: MdbaseClient | null = null, control: AppCollectionControlClient | null = null, connector: AppLocalConnector | null = null;
  let timers: TimersApi | undefined;
  const close = () => {
    if (stopped) return; stopped = true; signal.removeEventListener("abort", close);
    // Failure in one closer cannot leave another client/control waiter live.
    for (const stop of [() => timers?.close(), () => control?.close(), () => client?.close(), () => connector?.close(), () => dataPort.close(), () => controlPort.close()]) {
      try {stop();} catch { /* local fail-stop; original Worker still owns native/SQL */ }
    }
  };
  signal.addEventListener("abort", close, {once: true});
  try {
    connector = appLocalConnector(dataPort, {...scope, isCurrent: () => !stopped && !signal.aborted});
    control = appCollectionControlClient(controlPort, {scope, generation}, {signal, isCurrent: () => !stopped, onClose: close,
      ...(peopleEnabled ? {people: true} : {})});
    if(handoff.timerPort)timers=new TimersApi(appTimerPortClient(handoff.timerPort,{scope,generation},{signal,onClose:()=>{}}),{criteria:options.timerCriteria??[]});
    client = await MdbaseClient.connect({app: options.app, connector, reconnect: false, signal, ledger: control.ledger});
    if (stopped || signal.aborted) {
      // An ignored-abort connect may deliver AFTER the earlier closer set
      // stopped while client was still null. Own/close that original late
      // client directly; the idempotent earlier closer cannot do it again.
      client.close(); throw fail("fenced");
    }
    const people = peopleEnabled ? createAppCollectionPeople(client, control) : undefined;
    return Object.freeze({client, resourceSetup: control.resourceSetup, ...(people ? {people} : {}), journal: control.journal, scope, setupMode, close, ...(timers ? {timers} : {}),
      assess: (state: "ready" | "setup_required", signal: AbortSignal) => control!.assess(state, signal),
      setForeground: (active: boolean, signal: AbortSignal) => control!.setForeground(active, signal),
    });
  } catch (error) {close(); throw error;}
}

