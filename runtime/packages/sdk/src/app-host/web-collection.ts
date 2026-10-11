/** Concrete protected native collection composition. Runs in the original owned
 * Worker. One UI data client, SDK-owned journal/control, no duplicate leases or
 * app-private installation controller. Native host retains SQL close LAST. */
import { appServerOutcome, type AppServerProblem } from "./cp-problem.js";
import { MdbaseClient, type ClientOptions } from "../client.js";
import { TimersApi } from "../timers.js";
import { appTimerPortClient } from "./timer-port.js";
import { createAppCollectionSql, type AppCollectionSqlOptions } from "../app-storage/collection-sql.js";
import { AppCollectionJoinLedger } from "./collection-join-ledger.js";
import { AppCollectionSetupJournal, type AppCollectionSetupJournalOptions } from "./collection-setup-journal.js";
import { attachAppCollectionControl, appCollectionControlClient, type AppCollectionControlClient, type AppResourceSetupPort } from "./collection-control.js";
import { appLocalConnector, type AppLocalConnector } from "./local-facade.js";
import type { AppReplicaScope } from "./owner.js";
import type { AppWebSignInSessionOptions, AppWebCollectionConnection } from "./web-sign-in-session.js";
import type { ModelResourceSetupJournal } from "./collection-setup-types.js";
import { createAppCollectionPeople } from "./collection-people.js";
import type { MdbasePeopleClient } from "../people.js";

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
  let occupied = false;
  return async context => {
    if (occupied) throw fail("fenced"); occupied = true;
    const {host, installation: custody, signal: parentSignal, collection, setupPolicy} = context;
    const ownership = custody.isCurrent, displayName = collection.displayName;
    const scope = Object.freeze({account: context.scope.account, installation: context.scope.installation, collection: context.scope.collection});
    const original = JSON.stringify([scope.account, scope.installation, scope.collection]), life = new AbortController();
    let closed = false, foreground = true, timer: ReturnType<typeof setTimeout> | null = null;
    let driving: Promise<void> | null = null, closing: Promise<void> | null = null;
    let control: ReturnType<typeof attachAppCollectionControl> | null = null;
    let timers: ReturnType<typeof host.openTimersPort> = null;
    let journal: AppCollectionSetupJournal | null = null, data: MessageChannel | null = null, command: MessageChannel | null = null;
    let assessment: "ready" | "setup_required" = "setup_required";
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
      parentSignal.removeEventListener("abort", abort);
      closing = Promise.resolve().then(async () => {
        let failed = false;
        try {await timers?.close();} catch {failed = true;}
        try {await control?.close();} catch {failed = true;}
        // Notify UI data client before fencing native/SQL; appLocalConnector
        // rejects its hello/RPC/read waiters on this exact original scope.
        try {data?.port1.postMessage([1, JSON.stringify([scope.account, scope.installation, scope.collection]), "close"]);} catch {failed = true;}
        for (const port of [data?.port1, data?.port2, command?.port1, command?.port2]) {
          try {port?.close();} catch {failed = true;}
        }
        await driving?.catch(() => {});
        try {journal?.close();} catch {failed = true;}
        if (failed) throw fail("unavailable");
        listeners.clear(); occupied = false;
      });
      life.abort(); changed(); return closing;
    };
    const abort = () => {void close().catch(() => {});};
    // A live server refusal slows the drive: the server's retry delay while
    // migrating (5 s..10 min), else 5 min. It clears on the next accepted reply.
    const delay = () => {
      const outcome = appServerOutcome(problem);
      return outcome === null ? 250 : outcome === "collection_migrating" ? Math.min(600_000, Math.max(5_000, problem?.retryAfterMs ?? 30_000)) : 300_000;
    };
    const observe = () => {
      let next: AppServerProblem | null = null; try { next = host.serverProblem(); } catch { next = null; }
      if (next !== problem) { problem = next; changed(); }
    };
    const schedule = () => {
      if (!current() || !foreground || timer !== null || driving) return;
      timer = setTimeout(() => {
        timer = null; if (!current() || !foreground) return;
        const work = driving = host.driveCollection({signal: life.signal});
        void work.then(() => {if (driving === work) driving = null; if (current()) observe(); schedule();}, () => {if (driving === work) driving = null; foreground = false;});
      }, delay());
    };
    const setForeground = (active: boolean) => {check(); foreground = active; if (timer !== null) clearTimeout(timer); timer = null; if (active) schedule();};
    parentSignal.addEventListener("abort", abort, {once: true});
    try {
      check();
      journal = new AppCollectionSetupJournal({...options.setupJournal, scope, isCurrent: current}); // validate BUILD config before bootstrap IO
      const ledger = new AppCollectionJoinLedger({databaseName: options.joinDatabaseName, scope, isCurrent: current});
      const attempt = await ledger.prepare({signal: life.signal}); check();
      await host.bootstrapCloudCopy({scope, collectionCurrent: current, purpose: "join", outcomeMode: attempt.outcomeMode,
        signal: life.signal, ...(attempt.outcomeMode === "existing" ? {reconcile: "explicit-unknown-outcome" as const} : {}),
        fetch: options.fetch, allowLoopbackHttp: options.allowLoopbackHttp}); check();
      await ledger.complete({signal: life.signal}); check();
      const receipt = host.registeredReceipt();
      if (receipt.installationId !== scope.installation) throw fail("binding");
      await host.openCollectionSql({signal: life.signal, replicaId: receipt.deviceId, endpoint: 0, openSql}); check();
      await host.startCollectionLog({signal: life.signal, fetch: options.fetch, allowLoopbackHttp: options.allowLoopbackHttp});
      await host.waitForVerifiedRead({signal: life.signal}); check();
      const intent = await journal.load(life.signal); check();
      const setupMode = intent && intent.version !== 1 && (intent.phase === "attempted" || intent.phase === "confirmed") ? "reconcile-original" :
        intent === null && setupPolicy === "approved-new-collection" ? "approved-new" : "inspect";
      const generation = crypto.randomUUID();
      timers = host.openTimersPort({scope,generation,signal:life.signal}); check();
      data = new MessageChannel(); command = new MessageChannel();
      const resourceSetup = host.attachDataFacade(data.port1); check();
      control = attachAppCollectionControl(command.port1, {scope, generation}, {journal, resourceSetup, signal: life.signal, isCurrent: current,
        assess(state) {check(); assessment = state; changed();}, foreground: setForeground, onProtocolFailure: abort,
        ...(options.people === true ? {peopleAuthority: host.peopleAuthority()} : {})});
      const connection: AppWebNativeCollection = Object.freeze({scope, generation, isCurrent: current, setForeground});
      const result: AppWebCollectionConnection<AppWebNativeCollection> = {
        get state() {return current() ? assessment : "setup_required";},
        get problem() {return current() ? problem : null;}, connection, close,
        subscribe(listener) {check(); listeners.add(listener); return () => {listeners.delete(listener);};},
      };
      options.handoff(Object.freeze({schema: "mdbn-app-collection/1", scope, generation, displayName, setupMode, dataPort: data.port2, controlPort: command.port2,
        ...(options.people === true ? {people: true as const} : {}), ...(timers ? {timerPort:timers.port} : {})}));
      check(); schedule(); return Object.freeze(result);
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
    client = await MdbaseClient.connect({app: options.app, connector, reconnect: false, signal});
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
