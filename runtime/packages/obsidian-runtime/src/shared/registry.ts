/**
 * The shared runtime: one runtime instance per Obsidian process (shared ABI,
 * `replica-client-api.md` §13).
 *
 * Every plugin (TaskNotes, mdbase-obsidian, …) embeds a byte-identical,
 * versioned runtime build. At load it calls {@link registerRuntime}:
 * - the first plugin with a given runtime version instantiates it, later
 *   plugins with the same version reuse that instance (reference counted);
 * - the registry lives on `globalThis.__mdbase_runtime__`, keyed by runtime ABI
 *   major, so separately bundled copies of this module find each other.
 *
 * Per collection, {@link SharedRuntime.attach} applies the version-skew rule
 * (`skew.ts`): host, attach as a client of the current host, hand off to a
 * newer runtime, attach to the desktop daemon, or report `upgrade_required`.
 * Attachments are re-homed transparently after a handoff.
 *
 * **Trust.** Every plugin in the Obsidian process can reach this
 * global, the runtime instances on it and their memory. In-process isolation is
 * impossible, so plugins running in the vault's process are fully trusted.
 * What the registry does enforce is that **host privileges are opt-in**: a
 * session carries host authority (`approve_device`, recovery, settings) only
 * when the plugin asks for `{kind: "host"}`. First-party plugins (TaskNotes,
 * mdbase-obsidian) do; any other plugin connects with its grant like a remote
 * client, so a well-behaved third-party plugin never holds more than its grant.
 *
 * Within one browser profile, the folder Web Lock excludes other windows;
 * within one process this registry serialises attach/handoff per collection.
 * {@link tryAcquireFolderLease} also detects descriptor loss/IO failure and
 * requires consumers to fence hosting immediately onLost. Its descriptor
 * protocol is NOT atomic mutual exclusion against the daemon's OS lock;
 * shared exclusion or an explicit residual disposition remains a launch gate.
 */

import { commonApi, decideRole, isNewer, type ApiVersion, type Role, type RuntimeInfo } from "./skew.js";
import type { tryAcquireFolderLease } from "../index/lease.js";

/** The well-known global (§13 step 1). */
export const RUNTIME_GLOBAL = "__mdbase_runtime__";

/**
 * How a session authenticates (`mdbn_replica::api::SessionAuth`). `host` is the
 * hosting app's session (no grant, full rights, incl. device approval); `grant`
 * is a granted client (§12.3 authorisation, without Noise in-process).
 */
export type SessionAuth = { readonly kind: "host" } | { readonly kind: "grant"; readonly grant: string; readonly clientPk: Uint8Array };

/** An in-process client port (§12.1). Opaque to the registry. */
export interface ClientPort {
  close(): void;
}

/** What the registry needs from a runtime instance. */
export interface RuntimeInstance {
  readonly info: RuntimeInfo;
  /**
   * Open the collection as host: take the folder lease
   * ({@link tryAcquireFolderLease}, never the bare Web Lock), open the store and
   * the replica. Rejects if the lease is held elsewhere; when the lease reports
   * `onLost` (including IO failure), synchronously fence new operations, cancel
   * hosting and notify affected attachments. Register before opening the store:
   * loss is latched even when startup is slow. Descriptor checks are not an OS lock.
   */
  openHost(collectionId: string): Promise<void>;
  /**
   * Stop hosting: finish any in-flight append, flush the store, release the
   * lease (§13 step 3.1–3.2). Pending mutations stay in the store.
   */
  closeHost(collectionId: string): Promise<void>;
  /** An in-process port to a collection this instance hosts, at `api`. */
  connect(collectionId: string, api: ApiVersion, auth: SessionAuth): ClientPort;
  /** Release everything (last plugin using this instance unloaded). */
  dispose(): Promise<void>;
}

/** Facts the caller supplies when attaching. */
export interface AttachContext {
  /** The log's semantics ratchet, if known (from the store or the log head). */
  readonly logSemMajor: number | null;
  /** The desktop daemon hosts this collection. */
  readonly daemonHosts: boolean;
  /** The session's authority. Defaults to nothing: a plugin must say what it is. */
  readonly auth: SessionAuth;
}

/** A plugin's use of one collection. Its `port` changes after a handoff. */
export interface Attachment {
  readonly collectionId: string;
  /** The role this attachment ended up with. */
  readonly role: Role;
  /** The current port, or `null` for `daemon` / `upgrade_required` roles. */
  readonly port: ClientPort | null;
  /** Called after the port was replaced (handoff). */
  onRehome(cb: (port: ClientPort) => void): () => void;
  /** Called when the attachment can no longer be served (host gone, API incompatible). */
  onLost(cb: (reason: string) => void): () => void;
  detach(): Promise<void>;
}

interface LoadedRuntime {
  readonly info: RuntimeInfo;
  readonly instance: RuntimeInstance;
  readonly plugins: Set<string>;
  retiring: boolean;
}

interface AttachmentState {
  readonly plugin: string;
  readonly runtimeVersion: string;
  readonly collectionId: string;
  readonly auth: SessionAuth;
  role: Role;
  port: ClientPort | null;
  readonly rehome: Set<(p: ClientPort) => void>;
  readonly lost: Set<(reason: string) => void>;
}

interface CollectionState {
  hostVersion: string | null;
  readonly attachments: Set<AttachmentState>;
  /** Serialises attach/detach/handoff for this collection. */
  chain: Promise<unknown>;
}

/** One registry slot (one ABI major). */
export class SharedRuntime {
  private readonly runtimes = new Map<string, LoadedRuntime>();
  private readonly loading = new Map<string, Promise<LoadedRuntime>>();
  private readonly collections = new Map<string, CollectionState>();
  /** Lifecycle calls wait for retirement, including its asynchronous flush/dispose. */
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(readonly abiMajor: number) {}

  /** Runtime versions loaded in this process. */
  versions(): string[] {
    return [...this.runtimes.keys()];
  }

  /** The runtime hosting `collectionId` in this process, if any. */
  hostOf(collectionId: string): RuntimeInfo | null {
    const v = this.collections.get(collectionId)?.hostVersion;
    return v ? this.runtimes.get(v)!.info : null;
  }

  /**
   * Register `plugin` as a user of runtime `info.runtimeVersion`, instantiating
   * it with `create` only if this version is not loaded yet.
   */
  register(plugin: string, info: RuntimeInfo, create: () => Promise<RuntimeInstance>): Promise<RuntimeInfo> {
    return this.serialiseLifecycle(() => this.registerNow(plugin, info, create));
  }

  private async registerNow(plugin: string, info: RuntimeInfo, create: () => Promise<RuntimeInstance>): Promise<RuntimeInfo> {
    if (info.abiMajor !== this.abiMajor) throw new Error(`ABI ${info.abiMajor} registered in slot ${this.abiMajor}`);
    let rt = this.runtimes.get(info.runtimeVersion);
    if (!rt) {
      let p = this.loading.get(info.runtimeVersion);
      if (!p) {
        p = (async () => {
          const instance = await create();
          if (instance.info.runtimeVersion !== info.runtimeVersion) {
            throw new Error(`runtime reports ${instance.info.runtimeVersion}, expected ${info.runtimeVersion}`);
          }
          const loaded: LoadedRuntime = { info: instance.info, instance, plugins: new Set(), retiring: false };
          this.runtimes.set(info.runtimeVersion, loaded);
          return loaded;
        })();
        this.loading.set(info.runtimeVersion, p);
        p.finally(() => this.loading.delete(info.runtimeVersion)).catch(() => {});
      }
      rt = await p;
    }
    if (rt.retiring) throw new Error("runtime is retiring");
    rt.plugins.add(plugin);
    return rt.info;
  }

  /** Attach `plugin` (registered with `runtimeVersion`) to a collection. */
  attach(plugin: string, runtimeVersion: string, collectionId: string, ctx: AttachContext): Promise<Attachment> {
    return this.serialiseLifecycle(() => this.attachNow(plugin, runtimeVersion, collectionId, ctx));
  }

  private attachNow(plugin: string, runtimeVersion: string, collectionId: string, ctx: AttachContext): Promise<Attachment> {
    const col = this.collection(collectionId);
    return this.serialise(col, async () => {
      const me = this.runtimes.get(runtimeVersion);
      if (!me || me.retiring || !me.plugins.has(plugin)) throw new Error(`${plugin} has not registered an active runtime ${runtimeVersion}`);
      const host = col.hostVersion ? this.runtimes.get(col.hostVersion)!.info : null;
      const role = decideRole({ me: me.info, host, logSemMajor: ctx.logSemMajor, daemonHosts: ctx.daemonHosts });
      const st: AttachmentState = {
        plugin,
        runtimeVersion,
        collectionId,
        auth: ctx.auth,
        role,
        port: null,
        rehome: new Set(),
        lost: new Set(),
      };
      switch (role.kind) {
        case "host":
          await me.instance.openHost(collectionId);
          col.hostVersion = runtimeVersion;
          try {
            st.port = me.instance.connect(collectionId, best(me.info.speaks, me.info.serves), st.auth);
          } catch (error) {
            // No attachment owns this host yet. Roll back the open so a failed
            // session does not strand the folder lease until plugin unload.
            try {
              await me.instance.closeHost(collectionId);
              col.hostVersion = null;
            } catch (closeError) {
              // Retain hostVersion: we must not claim the lease was released.
              throw new AggregateError([error, closeError], "Opening the runtime session and closing its host both failed");
            }
            throw error;
          }
          break;
        case "handoff":
          await this.handoff(collectionId, col, me);
          st.role = { kind: "host" };
          st.port = me.instance.connect(collectionId, best(me.info.speaks, me.info.serves), st.auth);
          break;
        case "client":
          st.port = this.runtimes.get(role.of)!.instance.connect(collectionId, role.api, st.auth);
          break;
        case "daemon":
        case "upgrade_required":
          break;
      }
      col.attachments.add(st);
      return this.view(st);
    });
  }

  /**
   * Unregister `plugin`. Its attachments are detached; if it was the last user
   * of a runtime that hosts collections, each is handed to the newest remaining
   * runtime that may host it (or closed), and the instance is disposed.
   */
  unregister(plugin: string): Promise<void> {
    return this.serialiseLifecycle(() => this.unregisterNow(plugin));
  }

  private async unregisterNow(plugin: string): Promise<void> {
    for (const col of this.collections.values()) {
      for (const st of [...col.attachments]) if (st.plugin === plugin) await this.detach(st);
    }
    for (const [version, rt] of [...this.runtimes]) {
      if (!rt.plugins.delete(plugin) || rt.plugins.size > 0) continue;
      rt.retiring = true;
      try {
        for (const [id, col] of this.collections) {
          if (col.hostVersion !== version) continue;
          await this.serialise(col, async () => {
            await rt.instance.closeHost(id);
            col.hostVersion = null;
            await this.rehostAfterLoss(id, col);
          });
        }
        await rt.instance.dispose();
        this.runtimes.delete(version);
      } catch (error) {
        // Empty membership excludes this retiring instance from rehosting, but
        // failed close/dispose must restore a retryable cleanup owner. Keep it
        // retiring: dispose may have partially torn down the instance, so no new
        // registration/session may reuse it before cleanup succeeds.
        rt.plugins.add(plugin);
        throw error;
      }
    }
  }

  private collection(id: string): CollectionState {
    let c = this.collections.get(id);
    if (!c) {
      c = { hostVersion: null, attachments: new Set(), chain: Promise.resolve() };
      this.collections.set(id, c);
    }
    return c;
  }

  private serialiseLifecycle<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(fn, fn);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  private serialise<T>(col: CollectionState, fn: () => Promise<T>): Promise<T> {
    const next = col.chain.then(fn, fn);
    col.chain = next.catch(() => {});
    return next;
  }

  /** §13 step 3: the host finishes, flushes and releases; `to` opens; clients re-attach. */
  private async handoff(id: string, col: CollectionState, to: LoadedRuntime): Promise<void> {
    const from = this.runtimes.get(col.hostVersion!)!;
    for (const st of col.attachments) st.port?.close();
    await from.instance.closeHost(id);
    col.hostVersion = null;
    try {
      await to.instance.openHost(id);
    } catch (e) {
      // Reopen the old host so nobody is left without one.
      await from.instance.openHost(id);
      col.hostVersion = from.info.runtimeVersion;
      this.reconnectAll(id, col, from);
      throw e;
    }
    col.hostVersion = to.info.runtimeVersion;
    this.reconnectAll(id, col, to);
  }

  private async rehostAfterLoss(id: string, col: CollectionState): Promise<void> {
    if (col.attachments.size === 0) return;
    const candidates = [...new Set([...col.attachments].map((a) => a.runtimeVersion))]
      .map((v) => this.runtimes.get(v)!)
      .filter((r) => r && !r.retiring && r.plugins.size > 0)
      .sort((a, b) => (isNewer(a.info, b.info) ? -1 : isNewer(b.info, a.info) ? 1 : 0));
    const next = candidates[0];
    if (!next) {
      for (const st of col.attachments) lose(st, "host_unloaded");
      return;
    }
    await next.instance.openHost(id);
    col.hostVersion = next.info.runtimeVersion;
    this.reconnectAll(id, col, next);
  }

  private reconnectAll(id: string, col: CollectionState, host: LoadedRuntime): void {
    for (const st of col.attachments) {
      if (st.role.kind === "daemon" || st.role.kind === "upgrade_required") continue;
      const mine = this.runtimes.get(st.runtimeVersion)!.info;
      const api = st.runtimeVersion === host.info.runtimeVersion ? best(mine.speaks, mine.serves) : commonApi(mine.speaks, host.info.serves);
      if (!api) {
        st.port = null;
        st.role = { kind: "upgrade_required", reason: "host_api_incompatible" };
        lose(st, "host_api_incompatible");
        continue;
      }
      st.role = st.runtimeVersion === host.info.runtimeVersion ? { kind: "host" } : { kind: "client", of: host.info.runtimeVersion, api };
      st.port = host.instance.connect(id, api, st.auth);
      for (const cb of st.rehome) cb(st.port);
    }
  }

  private async detach(st: AttachmentState): Promise<void> {
    const col = this.collections.get(st.collectionId);
    if (!col || !col.attachments.has(st)) return;
    await this.serialise(col, async () => {
      // Check again at the point of mutation: a stale handle must never close
      // a replacement attachment's host, even if internal queue usage changes.
      if (!col.attachments.has(st)) return;
      st.port?.close();
      st.port = null;
      // The host keeps running while any attachment remains; it stops when the
      // last one leaves, so the lease is free for another window or the daemon.
      // Keep the last attachment registered until close succeeds. If flushing
      // fails, detach/unregister can retry instead of orphaning a held lease.
      if (col.attachments.size === 1 && col.hostVersion) {
        await this.runtimes.get(col.hostVersion)!.instance.closeHost(st.collectionId);
        col.hostVersion = null;
      }
      col.attachments.delete(st);
    });
  }

  private view(st: AttachmentState): Attachment {
    return {
      collectionId: st.collectionId,
      get role() {
        return st.role;
      },
      get port() {
        return st.port;
      },
      onRehome(cb) {
        st.rehome.add(cb);
        return () => st.rehome.delete(cb);
      },
      onLost(cb) {
        st.lost.add(cb);
        return () => st.lost.delete(cb);
      },
      detach: () => this.serialiseLifecycle(() => this.detach(st)),
    };
  }
}

function lose(st: AttachmentState, reason: string): void {
  st.port = null;
  for (const cb of st.lost) cb(reason);
}

function best(speaks: readonly ApiVersion[], serves: readonly ApiVersion[]): ApiVersion {
  const api = commonApi(speaks, serves);
  if (!api) throw new Error("runtime does not speak any API version it serves");
  return api;
}

type GlobalSlots = Record<number, SharedRuntime>;

/**
 * The process-wide slot for `abiMajor`, created on first use. Separately
 * bundled copies of this module (one per plugin) share it through the global.
 */
export function sharedRuntime(abiMajor: number, g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): SharedRuntime {
  let slots = g[RUNTIME_GLOBAL] as GlobalSlots | undefined;
  if (!slots) {
    slots = {};
    Object.defineProperty(g, RUNTIME_GLOBAL, { value: slots, enumerable: false, configurable: false, writable: false });
  }
  let slot = slots[abiMajor];
  if (!slot) {
    slot = new SharedRuntime(abiMajor);
    slots[abiMajor] = slot;
  }
  return slot;
}
