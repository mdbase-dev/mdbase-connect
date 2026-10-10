/**
 * Presence (`replica-client-api.md` §11): ephemeral per-record state (cursor,
 * selection, "editing"), relayed by the replica. Never touches the log.
 */
import type { CborValue } from "./cbor.js";
import { uuid as uuidCodec } from "./codec.js";
import type { MdbaseClient } from "./client.js";
import { mdbaseError } from "./errors.js";
import type { Session } from "./session.js";
import { PlainValue, toValue } from "./values.js";
import { Peer, presencePush, Uuid } from "./wire.js";

/** Presence state limit (§11). */
export const MAX_PRESENCE_STATE = 4096;
/** At most 10 updates per second per record; extra updates coalesce. */
const MIN_INTERVAL_MS = 100;

interface Joined {
  state: CborValue;
  last: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PresenceApi {
  private joined = new Map<Uuid, Joined>();
  private watchers = new Map<Uuid, Set<(peers: Peer[]) => void>>();
  private wired = new WeakSet<Session>();

  constructor(private client: MdbaseClient) {
    client.onSession(async (s) => {
      this.wire(s);
      // Rejoin and resubscribe after a reconnect.
      for (const [id, j] of this.joined) await s.request("presence_join", this.params(id, j.state));
      for (const id of this.watchers.keys()) await s.request("subscribe_presence", new Map([[0, uuidCodec.enc(id)]]));
    });
  }

  private wire(s: Session): void {
    if (this.wired.has(s)) return;
    this.wired.add(s);
    s.onPush("presence", (p) => {
      try {
        const v = presencePush.dec(p);
        for (const fn of this.watchers.get(v.record) ?? []) fn(v.peers);
      } catch {
        // ignore
      }
    });
  }

  private params(record: Uuid, state: CborValue): Map<number, CborValue> {
    return new Map<number, CborValue>([
      [0, uuidCodec.enc(record)],
      [1, state],
    ]);
  }

  private check(state: CborValue): void {
    // A cheap size bound; the replica enforces the exact limit.
    const n = JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v)).length;
    if (n > MAX_PRESENCE_STATE) {
      throw mdbaseError("too_large", "presence state over 4 KiB", { details: new Map([["limit", MAX_PRESENCE_STATE]]) });
    }
  }

  async join(record: Uuid, state: PlainValue): Promise<void> {
    const v = toValue(state);
    this.check(v);
    this.joined.set(record, { state: v, last: Date.now(), timer: null });
    const s = await this.client.ready();
    this.wire(s);
    await s.request("presence_join", this.params(record, v));
  }

  /** Update state; calls faster than 10/s coalesce into the latest state. */
  update(record: Uuid, state: PlainValue): void {
    const j = this.joined.get(record);
    if (!j) throw mdbaseError("invalid_request", "join the record's presence first");
    j.state = toValue(state);
    this.check(j.state);
    if (j.timer) return;
    const wait = Math.max(0, j.last + MIN_INTERVAL_MS - Date.now());
    j.timer = setTimeout(() => {
      j.timer = null;
      j.last = Date.now();
      if (this.joined.get(record) !== j) return;
      void this.client.call("presence_update", this.params(record, j.state)).catch(() => {});
    }, wait);
  }

  async leave(record: Uuid): Promise<void> {
    const j = this.joined.get(record);
    if (j?.timer) clearTimeout(j.timer);
    this.joined.delete(record);
    await this.client.call("presence_leave", new Map([[0, uuidCodec.enc(record)]])).catch(() => {});
  }

  /** Watch the peers on a record. Returns an unsubscribe function. */
  subscribe(record: Uuid, fn: (peers: Peer[]) => void): () => void {
    let set = this.watchers.get(record);
    const first = !set;
    if (!set) this.watchers.set(record, (set = new Set()));
    set.add(fn);
    if (first) {
      void this.client
        .ready()
        .then((s) => {
          this.wire(s);
          return s.request("subscribe_presence", new Map([[0, uuidCodec.enc(record)]]));
        })
        .catch(() => {});
    }
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.watchers.delete(record);
    };
  }
}
