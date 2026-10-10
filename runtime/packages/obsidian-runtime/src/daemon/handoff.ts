/**
 * Handing hosting from the Obsidian runtime (a vault-API host) to the desktop daemon
 * (`replica-client-api.md` §13 "one host per folder per machine";
 * authenticated daemon handoff messages).
 *
 * **Device identity:** the daemon enrols as a **new device**, and device
 * secrets never move between processes. In a synced collection this plugin is a keyed
 * device on the same machine, so it approves the daemon's enrolment itself, over the
 * authenticated link, with the normal commit-then-reveal flow (`ApproverApproval`).
 * No other device is needed. After the daemon hosts, the plugin's own device is retired:
 * it is revoked, which brings the usual rekey, and its key store is erased.
 *
 * Over the authenticated localhost session (§12.4):
 * 1. `handoff_offer {collection, sem, runtime_version}` → `handoff_accept {daemon_device}`,
 *    or a refusal. The daemon has requested its own enrolment, with a SAS commitment.
 * 1a. The plugin approves the daemon's device ({@link HandoffHost.approveDaemon}): it
 *    checks the enrol item in its own log view, challenges, checks the reveal, compares
 *    the codes over the link and appends the `key_grant`. If that fails, hosting stays
 *    here.
 * 2. The host finishes any in-flight append, flushes its store and **stops
 *    publishing** (`quiesce`).
 * 3. It sends its pending mutations in batches, `handoff_pending {mutations}`. The
 *    daemon enqueues each batch durably *before* it acknowledges with the mutation IDs
 *    it holds. Only then does the host drop those copies. Resubmission is idempotent by
 *    mutation ID, so an interruption at any point loses and duplicates nothing.
 * 4. Persist a device-local handoff intent in both journal copies, then send
 *    `handoff_ready {handoff_id, journal_head}`. The daemon durably binds its
 *    activation to that ID and replies `hosting` with the ID and daemon identity.
 * 5. The runtime re-attaches as a client plus editor fence.
 * **Local-user trust boundary.** The link relies on the owner-only link file and
 * daemon Noise key; processes holding both credentials can act as that daemon.
 * Handoff permits at most one key grant to a device enrolled under the user's own
 * account. Keep that grant visible in the completion notice and account device list;
 * the next rekey cuts it off. Do not treat the localhost link as isolation from
 * other local processes sharing those credentials or access to the plugin's storage.
 *
 * 6. It retires its own device ({@link HandoffHost.retireSelf}): it asks for a
 *    `device-revoke` of itself (the rekey follows, done by the daemon as host), then
 *    erases its key store. A failure here is reported and retried. It never brings
 *    hosting back.
 *
 * **Never two hosts.** Before sending `handoff_ready`, the plugin durably records a
 * device-local handoff intent. After that point a lost reply, rejection or crash never
 * permits automatic resumption. Startup reads this fence before opening a host and
 * reconciles the same handoff ID with the same authenticated daemon. Only a durable
 * terminal `aborted` status (late ready requests can never activate it) permits resume.
 * An unknown/unreachable daemon means wait, not host. Heartbeats are hints, not proof.
 */

/** A pending mutation, opaque to the handoff except for its ID. */
export interface PendingMutation {
  /** 16-byte mutation ID, hex. */
  readonly id: string;
  /** The encoded mutation with its captured fields, exactly as journaled. */
  readonly bytes: Uint8Array;
}

/** Device-local durable fence, scoped to this collection and plugin device. */
export interface HandoffIntent {
  readonly id: string;
  readonly daemonDevice: string;
  /** Noise public-key pin used for the authenticated link, not a fresh discovery hint. */
  readonly daemonNoisePk: string;
}

/** Device-local ownership state. A final marker never becomes a fresh host implicitly. */
export type HandoffState =
  | { readonly kind: "host" }
  | { readonly kind: "pending" | "handed_off"; readonly intent: HandoffIntent };

/** The host side's hooks into its own store. */
export interface HandoffHost {
  /** Exclusive collection/device lock shared by ALL wrappers/windows; includes resume. */
  withHandoffLock<T>(collection: string, run: () => Promise<T>): Promise<T>;
  /** Finish the in-flight append, flush, stop publishing and ingesting. */
  quiesce(): Promise<void>;
  /** Restart only before ready was attempted, or after identity-bound terminal abort. */
  resume(): Promise<void>;
  /** Pending mutations, oldest first. */
  pending(): Promise<PendingMutation[]>;
  /** Drop pending copies the daemon has durably taken (journal tombstones). */
  dropPending(ids: readonly string[]): Promise<void>;
  /** The journal head (highest version) for `handoff_ready`. */
  journalHead(): Promise<number>;
  /** Atomic snapshot before opening/publishing; unreadable state must fail closed. */
  handoffState(): Promise<HandoffState>;
  /**
   * Durable CAS in BOTH journal copies, under the shared lock. Compare full kind,
   * ID, device and pin. False means no change; an error may mean uncertain persistence.
   * Never overwrite another pending/final ownership fence. Final state retains the ID/pin.
   */
  compareHandoffState(expected: HandoffState, next: HandoffState): Promise<boolean>;
  /** Close the store (release the Web Lock lease) and re-attach as a client of the daemon. */
  becomeClient(): Promise<void>;
  /**
   * Approve the daemon's newly enrolled device with the normal approval flow over the
   * link. Rejects if the enrol item, commitment or codes don't check out. Never exports
   * this device's secrets.
   */
  approveDaemon(daemonDevice: string): Promise<void>;
  /** Request revocation of this plugin's device (rekey follows), then erase its key store. */
  retireSelf(): Promise<void>;
  /** The daemon device's enrol item, from this plugin's own log view. */
  enrolmentOf(device: string): Promise<{ account: string; kind: string } | null>;
  /** This plugin's account (from its own enrolment). */
  ownAccount(): string;
  /** Show a local notice (Obsidian `Notice`). */
  notify(message: string): void;
}

/** The request channel to the daemon over the localhost session. */
export interface HandoffChannel {
  /** Verified by the Noise connector, never supplied by the peer's reply body. */
  readonly peer: { readonly device: string; readonly noisePk: string };
  request(method: "handoff_offer", p: { collection: string; sem: { major: number; minor: number }; runtime_version: string }): Promise<{ accept: boolean; daemon_device?: string; reason?: string }>;
  request(method: "handoff_pending", p: { collection: string; mutations: PendingMutation[] }): Promise<{ held: string[] }>;
  request(method: "handoff_ready", p: { collection: string; handoff_id: string; journal_head: number }): Promise<{ handoff_id: string; daemon_device: string; hosting: boolean; reason?: string }>;
  /** `aborted` is durable/terminal: this ID can NEVER activate, including late ready. */
  request(method: "handoff_status", p: { collection: string; handoff_id: string }): Promise<{ handoff_id: string; daemon_device: string; status: "hosting" | "aborted" | "unknown" }>;
}

export type HandoffResult =
  | { readonly kind: "handed_off"; readonly moved: number; readonly retired: boolean; readonly retireError?: string }
  | { readonly kind: "refused"; readonly reason: string; readonly resumed: true }
  | { readonly kind: "failed"; readonly error: string; readonly resumed: boolean };

/** Most mutations per `handoff_pending` batch (keeps frames well under 16 MiB). */
export const HANDOFF_BATCH = 200;

// Separate bundles share this queue for the same host object. The backend lock
// additionally covers distinct wrappers/windows of the same collection/device.
const QUEUES = Symbol.for("mdbase.obsidian.handoff.queues.v2");
const globals = globalThis as typeof globalThis & { [QUEUES]?: WeakMap<HandoffHost, Map<string, Promise<void>>> };
const queues = globals[QUEUES] ??= new WeakMap<HandoffHost, Map<string, Promise<void>>>();

async function locked(host: HandoffHost, collection: string, run: () => Promise<HandoffResult>): Promise<HandoffResult> {
  let byCollection = queues.get(host);
  if (!byCollection) queues.set(host, byCollection = new Map());
  const before = byCollection.get(collection) ?? Promise.resolve();
  const operation = before.then(() => host.withHandoffLock(collection, run));
  const tail = operation.then(() => {}, () => {});
  byCollection.set(collection, tail);
  try {
    return await operation;
  } catch (e) {
    return { kind: "failed", error: String(e), resumed: false };
  } finally {
    if (byCollection.get(collection) === tail) byCollection.delete(collection);
  }
}

function sameIntent(a: HandoffIntent, b: HandoffIntent): boolean {
  return a.id === b.id && a.daemonDevice === b.daemonDevice && a.daemonNoisePk === b.daemonNoisePk;
}

async function transition(host: HandoffHost, expected: HandoffState, next: HandoffState): Promise<void> {
  if (!await host.compareHandoffState(expected, next)) throw new Error("handoff ownership CAS mismatch");
}

/** Run the host side of a handoff under one ownership-fence critical section. */
export function handOff(
  host: HandoffHost,
  ch: HandoffChannel,
  me: { collection: string; sem: { major: number; minor: number }; runtimeVersion: string; synced: boolean },
): Promise<HandoffResult> {
  return locked(host, me.collection, () => handOffLocked(host, ch, me));
}

async function handOffLocked(
  host: HandoffHost,
  ch: HandoffChannel,
  me: { collection: string; sem: { major: number; minor: number }; runtimeVersion: string; synced: boolean },
): Promise<HandoffResult> {
  // A previous attempt may already have activated the daemon. Never make a new
  // offer, move more intents or approve another device until it is reconciled.
  try {
    const state = await host.handoffState();
    if (state.kind !== "host") return reconcileLocked(host, ch, me, state.intent);
  } catch (e) {
    return { kind: "failed", error: String(e), resumed: false };
  }
  const offer: { accept: boolean; daemon_device?: string; reason?: string } = await ch
    .request("handoff_offer", { collection: me.collection, sem: me.sem, runtime_version: me.runtimeVersion })
    .catch((e) => ({ accept: false, reason: `link: ${String(e)}` }));
  if (!offer.accept || !offer.daemon_device) return { kind: "refused", reason: offer.reason ?? "refused", resumed: true };
  const daemonDevice = offer.daemon_device;
  if (daemonDevice !== ch.peer.device) return { kind: "refused", reason: "daemon_link_identity_mismatch", resumed: true };
  if (me.synced) {
    const why = daemonEnrolmentProblem(await host.enrolmentOf(daemonDevice), host.ownAccount());
    if (why) return { kind: "refused", reason: why, resumed: true };
    try {
      await host.approveDaemon(daemonDevice);
    } catch (e) {
      return { kind: "refused", reason: `daemon approval failed: ${String(e)}`, resumed: true };
    }
  }

  let fenced = false;
  let moved = 0;
  try {
    await host.quiesce();
    for (;;) {
      const batch = (await host.pending()).slice(0, HANDOFF_BATCH);
      if (batch.length === 0) break;
      const { held } = await ch.request("handoff_pending", { collection: me.collection, mutations: batch });
      const sent = new Set(batch.map((m) => m.id));
      const taken = held.filter((id) => sent.has(id));
      if (taken.length === 0) throw new Error("daemon held none of the batch");
      await host.dropPending(taken);
      moved += taken.length;
    }
    const journalHead = await host.journalHead();
    const intent: HandoffIntent = { id: crypto.randomUUID(), daemonDevice, daemonNoisePk: ch.peer.noisePk };
    await transition(host, { kind: "host" }, { kind: "pending", intent });
    fenced = true;
    const ready = await ch.request("handoff_ready", { collection: me.collection, handoff_id: intent.id, journal_head: journalHead });
    if (ready.handoff_id !== intent.id || ready.daemon_device !== daemonDevice) throw new Error("handoff reply identity mismatch");
    if (!ready.hosting) throw new Error(`daemon did not start hosting: ${ready.reason ?? "unknown"}`);
    await transition(host, { kind: "pending", intent }, { kind: "handed_off", intent });
    await host.becomeClient();
  } catch (e) {
    if (fenced) {
      // Ready may have succeeded even when its ACK was lost. The durable fence
      // survives restart; only terminal status reconciliation may release it.
      return { kind: "failed", error: String(e), resumed: false };
    }
    // Mutations the daemon already holds are dropped here, and the daemon dedups
    // re-offers by ID, so resuming loses and duplicates nothing.
    // Persistence may have succeeded before throwing. Never resume across an
    // uncertain or foreign fence; this read and resume stay inside the SAME lock.
    try {
      if ((await host.handoffState()).kind !== "host") return { kind: "failed", error: String(e), resumed: false };
      await host.resume();
      return { kind: "failed", error: String(e), resumed: true };
    } catch (resumeError) {
      return { kind: "failed", error: `${String(e)}; ${String(resumeError)}`, resumed: false };
    }
  }
  return finishHandoff(host, me.synced, moved);
}

/** Reconcile a durable intent after lost ACK/restart. The channel MUST pin its daemon. */
export function reconcileHandoff(
  host: HandoffHost,
  ch: HandoffChannel,
  me: { collection: string; synced: boolean },
  intent: HandoffIntent,
): Promise<HandoffResult> {
  return locked(host, me.collection, () => reconcileLocked(host, ch, me, intent));
}

async function reconcileLocked(host: HandoffHost, ch: HandoffChannel, me: { collection: string; synced: boolean }, intent: HandoffIntent): Promise<HandoffResult> {
  try {
    const state = await host.handoffState();
    if (state.kind === "host" || !sameIntent(state.intent, intent)) throw new Error("stale handoff reconciliation");
    if (ch.peer.device !== intent.daemonDevice || ch.peer.noisePk !== intent.daemonNoisePk) throw new Error("handoff channel pin mismatch");
    // Completed ownership must never be overwritten/re-offered by a queued call.
    if (state.kind === "handed_off") {
      await host.becomeClient();
      return finishHandoff(host, me.synced, 0);
    }
    const status = await ch.request("handoff_status", { collection: me.collection, handoff_id: intent.id });
    if (status.handoff_id !== intent.id || status.daemon_device !== intent.daemonDevice) throw new Error("handoff status identity mismatch");
    if (status.status === "aborted") {
      await transition(host, state, { kind: "host" });
      await host.resume();
      return { kind: "failed", error: "handoff terminally aborted", resumed: true };
    }
    if (status.status !== "hosting") throw new Error("handoff state unknown; hosting remains fenced");
    await transition(host, state, { kind: "handed_off", intent });
    await host.becomeClient();
  } catch (e) {
    return { kind: "failed", error: String(e), resumed: false };
  }
  return finishHandoff(host, me.synced, 0);
}

async function finishHandoff(host: HandoffHost, synced: boolean, moved: number): Promise<HandoffResult> {
  host.notify(
    synced
      ? "mdbase: the desktop app now syncs this vault. Obsidian approved its device and works through it from now on. If you didn't just install or start mdbase, review your devices in mdbase account settings."
      : "mdbase: the desktop app now manages this vault. Obsidian works through it from now on.",
  );
  if (!synced) return { kind: "handed_off", moved, retired: true };
  try {
    await host.retireSelf();
    return { kind: "handed_off", moved, retired: true };
  } catch (e) {
    return { kind: "handed_off", moved, retired: false, retireError: String(e) };
  }
}

/** Device kinds a daemon may enrol as. */
const DAEMON_KINDS = new Set(["desktop", "cli"]);

/**
 * Why the plugin must not approve this enrolment, or `null`. Only a `desktop` or `cli`
 * device of **this plugin's own account** is approved here. A daemon on another
 * account goes through the cross-account approval flow instead.
 */
export function daemonEnrolmentProblem(enrol: { account: string; kind: string } | null, ownAccount: string): string | null {
  if (!enrol) return "daemon_not_enrolled";
  if (enrol.account.toLowerCase() !== ownAccount.toLowerCase()) return "daemon_other_account";
  if (!DAEMON_KINDS.has(enrol.kind)) return "daemon_wrong_kind";
  return null;
}

/** What the plugin does at start for a synced collection (§13 rules 1–4 plus the marker). */
export function hostingDecision(s: { daemonReachable: boolean; handedOffTo: string | null; pendingHandoffTo?: string | null; mobile: boolean }): "attach_to_daemon" | "host" | "offer_handoff" | "wait_for_daemon" | "reconcile_handoff" {
  if (s.pendingHandoffTo) return s.daemonReachable ? "reconcile_handoff" : "wait_for_daemon";
  if (s.mobile) return "host";
  if (s.handedOffTo) return s.daemonReachable ? "attach_to_daemon" : "wait_for_daemon";
  return s.daemonReachable ? "offer_handoff" : "host";
}
