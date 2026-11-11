import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { tokenHash } from "../../security.js";
import { LocalRelayBroker, pipeSubject } from "../relay/relay-broker.js";
import { DEFAULT_NOISE_PIPE_LIMITS, registerNoisePipeClientRoute } from "./noise-pipes.js";

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
    this.emit("close");
  });
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.useRealTimers();
});

/** Count real admission calls against synthetic query results, as in the native
 * catalog budget test. No admission function is mocked or replaced. */
async function fixture(native = false) {
  vi.useFakeTimers();
  const auth = { access_token: randomUUID(), collection: randomUUID(), grant: randomUUID(), device: randomUUID() };
  const credentials = [auth];
  const revokedGrants = new Set<string>(), revokedTokens = new Set<string>(), revokedDevices = new Set<string>();
  const state = { connector: "connector", unavailable: false };
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    if (state.unavailable) throw new Error("database unavailable");
    if (sql.includes("FROM access_tokens tok")) {
      const credential = credentials.find(c => tokenHash(c.access_token) === values[0] && c.collection === values[1] && (!sql.includes("SELECT col.connector_id") || c.grant === values[2]));
      const active = credential && !revokedGrants.has(credential.grant) && !revokedTokens.has(credential.access_token);
      if (sql.includes("SELECT col.connector_id")) return { rows: !native && active && credential.grant === values[2] ? [{ connector_id: state.connector }] : [] };
      return { rows: active ? [{ grant_id: credential.grant, user_id: "owner", has_client_key: true, policy_active: true, sync: "private" }] : [] };
    }
    if (sql.includes("FROM next_collections n")) return { rows: [{ collection_id: (values[0] as string[])[0], sync: "private", deleted: false, op: "member-set", role: "owner" }] };
    if (sql.includes("WITH devices AS")) return { rows: revokedDevices.has(String(values[2])) ? [] : [{ collection_id: (values[0] as string[])[0], device_id: values[2], connector_id: state.connector }] };
    if (sql.includes("SELECT c.relay_generation FROM connectors")) return { rows: [{ relay_generation: 1 }] };
    throw new Error(`Unexpected pipe query: ${sql}`);
  });
  const broker = new LocalRelayBroker();
  const deviceCloses: string[] = [];
  const accept = async (connector: string) => broker.subscribePipe(pipeSubject("open", connector, "1"), data => {
    const { pipe_id: id } = JSON.parse(Buffer.from(data).toString()) as { pipe_id: string };
    void broker.subscribePipe(pipeSubject(id, "device"), message => {
      if (message[0] === 2) deviceCloses.push(Buffer.from(message.subarray(1)).toString());
    });
    void broker.publishPipe(pipeSubject(id, "client"), Buffer.of(1));
  });
  await accept(state.connector);
  const get = vi.fn();
  registerNoisePipeClientRoute({ get } as unknown as FastifyInstance, { db: { query } as unknown as DatabasePool, broker });
  const handle = get.mock.calls[0]![2] as (socket: WebSocket) => void;
  const clients: Socket[] = [];
  cleanup.push(async () => {
    for (const client of clients) client.close();
    await broker.close();
  });
  const open = async (overrides: Partial<typeof auth> = {}) => {
    const credential = { ...auth, ...overrides };
    credentials.unshift(credential);
    const client = new Socket();
    clients.push(client);
    handle(client as unknown as WebSocket);
    client.emit("message", Buffer.from(JSON.stringify({ type: "pipe_auth", ...credential, device_noise_pk: "11".repeat(32) })), false);
    await vi.advanceTimersByTimeAsync(0);
    return client;
  };
  const tick = () => vi.advanceTimersByTimeAsync(DEFAULT_NOISE_PIPE_LIMITS.revalidateMs);
  return { auth, open, tick, query, revokedGrants, revokedTokens, revokedDevices, deviceCloses, state, accept };
}

describe("Noise pipe revalidation query budget", () => {
  it.each([false, true])("checks 1 or 8 pipes once per interval (native: %s)", async native => {
    const f = await fixture(native);
    const first = await f.open();
    expect(first.send).toHaveBeenCalledTimes(1);
    f.query.mockClear();
    await f.tick();
    const single = f.query.mock.calls.length;
    expect(single).toBe(native ? 4 : 1);
    for (let i = 1; i < 8; i++) {
      const client = await f.open();
      expect(client.send).toHaveBeenCalledTimes(1);
    }
    // Every additional pipe still performs its own admission and generation read.
    expect(f.query.mock.calls.length - single).toBe(7 * (single + 1));
    for (let interval = 0; interval < 2; interval++) {
      f.query.mockClear();
      await f.tick();
      // Before grouping: 8 legacy reads or 32 native reads on every interval.
      expect(f.query).toHaveBeenCalledTimes(single);
    }
  });

  it.each(["grant", "token", "device"])("closes all 8 pipes within an interval after %s revocation, leaving another grant open", async revoked => {
    const f = await fixture(true);
    const clients = await Promise.all(Array.from({ length: 8 }, () => f.open()));
    const other = await f.open({ access_token: randomUUID(), grant: randomUUID(), device: randomUUID() });
    await f.tick();
    // Revoke just after a successful shared check: no previous result may survive.
    if (revoked === "grant") f.revokedGrants.add(f.auth.grant);
    else if (revoked === "token") f.revokedTokens.add(f.auth.access_token);
    else f.revokedDevices.add(f.auth.device);
    await f.tick();
    for (const client of clients) expect(client.close).toHaveBeenCalledWith(4403, "grant_inactive");
    expect(f.deviceCloses).toEqual(Array(8).fill("grant_revoked"));
    expect(other.close).not.toHaveBeenCalled();
    f.query.mockClear();
    await f.tick();
    expect(f.query).toHaveBeenCalledTimes(4);
  });

  it.each([1, 8])("fails closed at both ends on a throwing check for %i pipes and removes the timer", async size => {
    const f = await fixture();
    const clients = await Promise.all(Array.from({ length: size }, () => f.open()));
    f.query.mockClear();
    f.state.unavailable = true;
    await f.tick();
    for (const client of clients) expect(client.close).toHaveBeenCalledWith(4404, "connector_offline");
    expect(f.deviceCloses).toEqual(Array(size).fill("authorization_unavailable"));
    expect(f.query).toHaveBeenCalledTimes(1);
    await f.tick();
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it.each(["access_token", "collection", "grant", "device", "connector"] as const)("does not group differing %s inputs", async field => {
    const f = await fixture();
    const first = await f.open();
    if (field === "connector") {
      f.state.connector = "replacement";
      await f.accept(f.state.connector);
    }
    const other = await f.open(field === "connector" ? {} : { [field]: randomUUID() });
    f.query.mockClear();
    await f.tick();
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(other.close).not.toHaveBeenCalled();
    if (field === "connector") expect(first.close).toHaveBeenCalledWith(4403, "grant_inactive");
    else expect(first.close).not.toHaveBeenCalled();
  });

  it("validates late arrivals on opening and on the existing group's next tick", async () => {
    const f = await fixture();
    const first = await f.open();
    await vi.advanceTimersByTimeAsync(5_000);
    const late = await f.open();
    expect(f.query).toHaveBeenCalledTimes(4);
    f.revokedGrants.add(f.auth.grant);
    const refused = await f.open();
    expect(refused.close).toHaveBeenCalledWith(4403, "grant_inactive");
    await vi.advanceTimersByTimeAsync(25_000);
    for (const client of [first, late]) expect(client.close).toHaveBeenCalledWith(4403, "grant_inactive");
  });

  it("keeps checking the remaining pipes after the first member closes", async () => {
    const f = await fixture();
    const first = await f.open(), remaining = await f.open();
    first.close();
    f.query.mockClear();
    await f.tick();
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(remaining.close).not.toHaveBeenCalled();
    f.revokedGrants.add(f.auth.grant);
    await f.tick();
    expect(remaining.close).toHaveBeenCalledWith(4403, "grant_inactive");
  });

  it("does not overlap a pending group check, and independently admits arrivals during it", async () => {
    const f = await fixture();
    const first = await f.open();
    let resume!: () => void;
    f.query.mockClear();
    f.query.mockImplementationOnce(() => new Promise(resolve => { resume = () => resolve({ rows: [] }); }));
    await f.tick();
    const late = await f.open();
    expect(late.send).toHaveBeenCalledTimes(1);
    expect(f.query).toHaveBeenCalledTimes(3); // One held check, plus opening admission and generation.
    await f.tick();
    expect(f.query).toHaveBeenCalledTimes(3);
    f.revokedGrants.add(f.auth.grant);
    resume();
    await vi.advanceTimersByTimeAsync(0);
    for (const client of [first, late]) expect(client.close).toHaveBeenCalledWith(4403, "grant_inactive");
  });

  it("removes empty groups even during a pending check, without affecting a replacement group", async () => {
    const f = await fixture();
    const first = await f.open();
    let resume!: () => void;
    f.query.mockImplementationOnce(() => new Promise(resolve => { resume = () => resolve({ rows: [] }); }));
    await f.tick();
    first.close();
    const replacement = await f.open();
    resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.close).not.toHaveBeenCalled();
    f.query.mockClear();
    await f.tick();
    expect(f.query).toHaveBeenCalledTimes(1);
    replacement.close();
    await f.tick();
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});
