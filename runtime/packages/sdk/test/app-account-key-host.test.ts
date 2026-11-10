import { describe, expect, it, vi } from "vitest";
import {
  AccountKeyError, domainHash, encodeBundle, formatRecoveryKey, keyId, sealBundle, type Argon2idRunner,
} from "../src/account-key.js";
import { toHex } from "../src/cbor.js";
import {
  AppAccountKeySealedBundle, AppAccountKeyUnlockError, AppCpAccountKeyControl, readAccountKeyMode, unlockPrivateDevice,
  type AppAccountKeyNative, type AppAccountKeySession,
} from "../src/app-host/account-key-host.js";
import { AppAccountKeyProofUnavailableError, AppStrictDeviceApprovalError, type AppAccountKeyState } from "../src/app-host/wasm-runtime.js";

const ACCOUNT = "0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11";
const CONNECTOR = "22222222-2222-4222-8222-222222222222";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const COLLECTION = "33333333-3333-4333-8333-333333333333";
const CP = "https://cp.example.test";
const PASSWORD = "correct horse battery staple";
const BEARER = "installation-bearer";
const counter = (seed: number) => (n: number) => new Uint8Array(n).map((_, i) => (seed * 7 + i) & 0xff);
// A fast stand-in KDF; the real one is pinned in account-key.test.ts.
const fastKdf: Argon2idRunner = async (pw, salt) => domainHash("test-kdf", new Uint8Array([...pw, ...salt]));
const R = counter(9)(32);
const SIGNATURE = new Uint8Array(64).fill(0x5a);

type Call = {method: string; path: string; headers: Record<string, string>};
/** A stubbed control plane with the three admitted routes and their real shapes. */
async function controlPlane(mode: "password" | "strict" | "none" = "password") {
  const bundle = await sealBundle(R, PASSWORD, ACCOUNT, {entropy: counter(3), argon2id: fastKdf});
  const row = {mode: "password", version: 1, key_id: toHex(keyId(R)), bundle: toHex(encodeBundle(bundle))};
  const calls: Call[] = [];
  let n = 0;
  const issued = new Set<string>();
  const state = {mode, fetchStatus: 200 as number, fetchBody: null as unknown, challengeBody: null as unknown, retryAfter: null as string | null, statusStatus: 200 as number, statusBody: undefined as unknown};
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", ...headers}});
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), headers = {...(init?.headers as Record<string, string>)};
    calls.push({method: init?.method ?? "GET", path: url.pathname, headers});
    if (url.origin !== CP || headers.authorization !== `Bearer ${BEARER}`) return json(401, {error: {code: "unauthorized"}});
    if (init?.redirect !== "error" || init?.credentials !== "omit" || init?.cache !== "no-store") return json(400, {error: {code: "invalid_request"}});
    if (url.pathname === "/v1/next/account-key/status" && init?.method === "GET") {
      if (state.statusStatus !== 200) return json(state.statusStatus, {error: {code: "unavailable"}});
      if (state.statusBody !== undefined) return json(200, state.statusBody);
      if (state.mode === "none") return json(200, {mode: "none", version: 0});
      // What Connect answers an installation: no strict `complete`/`pending` witnesses.
      if (state.mode === "strict") return json(200, {mode: "strict", version: 2});
      return json(200, {mode: "password", version: row.version, key_id: row.key_id});
    }
    if (url.pathname === "/v1/next/devices/challenge" && init?.method === "POST") {
      if (state.challengeBody) return json(200, state.challengeBody);
      const challenge = toHex(new Uint8Array(32).fill(++n)); issued.add(challenge);
      return json(200, {challenge, expires_at: Date.now() + 60_000});
    }
    if (url.pathname === "/v1/next/account-key" && init?.method === "GET") {
      if (state.fetchStatus !== 200) return json(state.fetchStatus, {error: {code: state.fetchStatus === 429 ? "rate_limited" : "forbidden"}}, state.retryAfter ? {"retry-after": state.retryAfter} : {});
      // Single-use challenge, the approved device and a 64-byte proof, as the server checks.
      if (headers["x-mdbase-device-id"] !== DEVICE || !issued.delete(headers["x-mdbase-challenge"] ?? "") || headers["x-mdbase-signature"] !== toHex(SIGNATURE))
        return json(403, {error: {code: "invalid_proof"}});
      if (state.fetchBody) return json(200, state.fetchBody);
      if (state.mode === "none") return json(200, {mode: "none", version: 0});
      if (state.mode === "strict") return json(200, {mode: "strict", version: 2});
      return json(200, row);
    }
    return json(404, {error: {code: "not_found"}});
  });
  const paths = () => calls.map(call => `${call.method} ${call.path}`);
  return {fetch: fetch as unknown as typeof globalThis.fetch, calls, paths, state, row};
}
function session(overrides: Partial<AppAccountKeySession> = {}) {
  let current = true;
  const value: AppAccountKeySession = {accountId: ACCOUNT, connectorId: CONNECTOR, deviceId: DEVICE, collection: COLLECTION, cpOrigin: CP,
    isCurrent: () => current, connectorBearer: vi.fn(async () => BEARER), ...overrides};
  return {value, end: () => {current = false;}};
}
/** The native device: records what it was lent, and keys after `turns` log turns. */
function native(options: {start?: AppAccountKeyState; unlocked?: AppAccountKeyState; turns?: number; head?: number; proof?: boolean} = {}) {
  let state: AppAccountKeyState = options.start ?? {state: "pending"}, head = options.head ?? 7, turns = options.turns ?? 1, started = false;
  const loans: {seen: string; bytes: Uint8Array}[] = [];
  const port: AppAccountKeyNative = {
    supportsFetchProof: vi.fn(() => options.proof !== false),
    signFetch: vi.fn((challenge: Uint8Array) => {
      if (options.proof === false) throw new AppAccountKeyProofUnavailableError();
      expect(challenge).toHaveLength(32); return SIGNATURE.slice();
    }),
    unlockConsuming: vi.fn((secret: Uint8Array) => {
      loans.push({seen: toHex(secret), bytes: secret}); started = true;
      if (options.unlocked) state = options.unlocked;
      return state;
    }),
    status: vi.fn(() => state),
    drive: vi.fn(async () => {
      if (head <= 0) { head = options.head === 0 ? 0 : 7; return; }
      if (started && state.state === "pending" && --turns <= 0) state = {state: "keyed"};
    }),
    headKnown: vi.fn(() => head),
  };
  return {port, loans, set: (next: AppAccountKeyState) => {state = next;}};
}
const reason = (work: Promise<unknown>) => work.then(() => "ok", error =>
  error instanceof AppAccountKeyUnlockError ? `${error.reason}${error.detail ? `:${error.detail}` : ""}` : `other:${error instanceof AccountKeyError ? error.code : String(error)}`);
const run = (cp: {fetch: typeof fetch}, s: AppAccountKeySession, n: AppAccountKeyNative, secret: Parameters<typeof unlockPrivateDevice>[2] = {password: PASSWORD},
  extra: Partial<Parameters<typeof unlockPrivateDevice>[3]> = {}) =>
  unlockPrivateDevice(s, n, secret, {fetch: cp.fetch, argon2id: fastKdf, signal: new AbortController().signal, ...extra});

describe("account-key mode for a locked Private device", () => {
  it.each(["password", "strict", "none"] as const)("reads %s from the status route alone: no challenge, no proof, no bundle", async mode => {
    const cp = await controlPlane(mode);
    expect(await readAccountKeyMode(session().value, {fetch: cp.fetch, signal: new AbortController().signal})).toBe(mode);
    expect(cp.paths()).toEqual(["GET /v1/next/account-key/status"]);
    expect(Object.keys(cp.calls[0]!.headers)).toEqual(["authorization"]);
  });
  it.each([
    ["strict with the account's completion witnesses", {mode: "strict", version: 2, complete: false, pending: [{collection_id: COLLECTION}]}, "strict"],
    ["strict with nothing else", {mode: "strict"}, "strict"],
    ["a password with no key id", {mode: "password", version: 1}, "password"],
    ["a password with fields this SDK does not know", {mode: "password", version: 1, key_id: "ab".repeat(16), later: {field: true}}, "password"],
    ["none with no version", {mode: "none"}, "none"],
  ] as const)("reads the mode alone from %s", async (_name, body, mode) => {
    const cp = await controlPlane(); cp.state.statusBody = body;
    expect(await readAccountKeyMode(session().value, {fetch: cp.fetch, signal: new AbortController().signal})).toBe(mode);
  });
  it.each([["an unknown mode", {mode: "escrow", version: 1}], ["no mode", {version: 1}], ["a mode that is not a string", {mode: ["strict"]}], ["a list", ["strict"]]])(
    "never reads %s as one of the three states", async (_name, body) => {
      const cp = await controlPlane(); cp.state.statusBody = body;
      await expect(reason(readAccountKeyMode(session().value, {fetch: cp.fetch, signal: new AbortController().signal}))).resolves.toBe("unavailable:response");
    });
  it("never guesses a mode: a failed or malformed status read rejects with a typed problem", async () => {
    const cp = await controlPlane();
    cp.state.statusStatus = 503;
    await expect(reason(readAccountKeyMode(session().value, {fetch: cp.fetch, signal: new AbortController().signal}))).resolves.toMatch(/^unavailable/);
    const offline = vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(reason(readAccountKeyMode(session().value, {fetch: offline, signal: new AbortController().signal}))).resolves.toBe("unavailable:network");
  });
  it("a cancelled read rejects as cancelled, not as a problem to show", async () => {
    const cp = await controlPlane(), stop = new AbortController(); stop.abort();
    await expect(reason(readAccountKeyMode(session().value, {fetch: cp.fetch, signal: stop.signal}))).resolves.toBe("other:cancelled");
    expect(cp.calls).toHaveLength(0);
  });
});

describe("account-key unlock of one adopted Private device", () => {
  it("unlocks with the encryption password: status, challenge, proved fetch, native self-grant, then keyed", async () => {
    const cp = await controlPlane(), s = session(), n = native(), modes: string[] = [];
    await run(cp, s.value, n.port, {password: PASSWORD}, {onMode: mode => {modes.push(mode);}});
    expect(cp.paths()).toEqual(["GET /v1/next/account-key/status", "POST /v1/next/devices/challenge", "GET /v1/next/account-key"]);
    const fetched = cp.calls[2]!.headers;
    expect(fetched["x-mdbase-device-id"]).toBe(DEVICE);
    expect(fetched["x-mdbase-challenge"]).toMatch(/^[0-9a-f]{64}$/);
    expect(fetched["x-mdbase-signature"]).toBe(toHex(SIGNATURE));
    // The proof headers go to the bundle route only.
    expect(Object.keys(cp.calls[0]!.headers)).toEqual(["authorization"]);
    expect(Object.keys(cp.calls[1]!.headers)).toEqual(["authorization"]);
    expect(modes).toEqual(["password"]);
    // The native device was lent exactly R, once, and the loan is wiped.
    expect(n.loans.map(loan => loan.seen)).toEqual([toHex(R)]);
    expect(n.loans[0]!.bytes.every(v => v === 0)).toBe(true);
    expect(n.port.drive).toHaveBeenCalledTimes(1);
    expect(n.port.status().state).toBe("keyed");
  });
  it("unlocks with the recovery key", async () => {
    const cp = await controlPlane(), n = native();
    await run(cp, session().value, n.port, {recoveryKey: formatRecoveryKey(R)});
    expect(n.loans.map(loan => loan.seen)).toEqual([toHex(R)]);
    expect(n.loans[0]!.bytes.every(v => v === 0)).toBe(true);
  });
  it("a device the grant keys at once needs no log turn", async () => {
    const cp = await controlPlane(), n = native({unlocked: {state: "keyed"}});
    await run(cp, session().value, n.port);
    expect(n.port.drive).not.toHaveBeenCalled();
  });
  it("a wrong password is wrong_secret and never reaches the native device", async () => {
    const cp = await controlPlane(), n = native();
    await expect(reason(run(cp, session().value, n.port, {password: "correct horse battery stapl3"}))).resolves.toBe("wrong_secret");
    expect(n.port.unlockConsuming).not.toHaveBeenCalled();
    expect(n.port.status().state).toBe("pending");
  });
  it("a recovery key of another account key is wrong_secret; a malformed one is invalid_recovery_key", async () => {
    const cp = await controlPlane(), n = native();
    await expect(reason(run(cp, session().value, n.port, {recoveryKey: formatRecoveryKey(counter(4)(32))}))).resolves.toBe("wrong_secret");
    await expect(reason(run(cp, session().value, n.port, {recoveryKey: "not a recovery key"}))).resolves.toMatch(/^invalid_recovery_key/);
    expect(n.port.unlockConsuming).not.toHaveBeenCalled();
  });
  it.each([["none", "no_account_key"], ["strict", "unlock_strict"]] as const)("%s accounts are refused from the status answer, before any challenge or bundle fetch", async (mode, expected) => {
    const cp = await controlPlane(mode), n = native(), modes: string[] = [];
    await expect(reason(run(cp, session().value, n.port, {password: PASSWORD}, {onMode: m => {modes.push(m);}}))).resolves.toBe(expected);
    expect(cp.paths()).toEqual(["GET /v1/next/account-key/status"]);
    expect(modes).toEqual([mode]);
    expect(n.port.signFetch).not.toHaveBeenCalled();
    expect(n.port.unlockConsuming).not.toHaveBeenCalled();
  });
  it("a runtime without the fetch signer reads unlock_unavailable and spends no challenge or fetch budget", async () => {
    const cp = await controlPlane(), n = native({proof: false});
    await expect(reason(run(cp, session().value, n.port))).resolves.toBe("unlock_unavailable");
    expect(cp.paths()).toEqual(["GET /v1/next/account-key/status"]);
    expect(n.port.unlockConsuming).not.toHaveBeenCalled();
  });
  it("the server's fetch budget reads rate_limited with its retry delay", async () => {
    const cp = await controlPlane(), n = native();
    cp.state.fetchStatus = 429; cp.state.retryAfter = "120";
    const error = await run(cp, session().value, n.port).catch(e => e);
    expect(error).toBeInstanceOf(AppAccountKeyUnlockError);
    expect(error).toMatchObject({reason: "rate_limited", retryAfterMs: 120_000});
    expect(n.port.unlockConsuming).not.toHaveBeenCalled();
  });
  it("a refused bundle fetch (installation not admitted) is unavailable, not a wrong secret", async () => {
    const cp = await controlPlane(), n = native();
    cp.state.fetchStatus = 403;
    await expect(reason(run(cp, session().value, n.port))).resolves.toMatch(/^unavailable/);
    expect(n.port.unlockConsuming).not.toHaveBeenCalled();
  });
  it("an already keyed device returns without any request or secret use", async () => {
    const cp = await controlPlane(), n = native({start: {state: "keyed"}});
    await run(cp, session().value, n.port);
    expect(cp.calls).toHaveLength(0);
    expect(n.port.unlockConsuming).not.toHaveBeenCalled();
  });
  it("a grant this collection refuses is unlock_failed with the native reason, and the loan is still wiped", async () => {
    const cp = await controlPlane(), n = native({unlocked: {state: "refused", reason: "not_enrolled" as never}});
    await expect(reason(run(cp, session().value, n.port))).resolves.toBe("unlock_failed:not_enrolled");
    expect(n.loans[0]!.bytes.every(v => v === 0)).toBe(true);
  });
  it("a grant that does not apply within the bound is unavailable (grant_pending), not a wrong secret", async () => {
    const cp = await controlPlane(), n = native({turns: 1_000});
    await expect(reason(run(cp, session().value, n.port, {password: PASSWORD}, {settleMs: 1}))).resolves.toBe("unavailable:grant_pending");
    expect(n.loans[0]!.bytes.every(v => v === 0)).toBe(true);
  });
  it("takes one log turn when the head is unknown, and refuses to unlock against an unknown head", async () => {
    const cp = await controlPlane(), n = native({head: -1});
    await run(cp, session().value, n.port);
    expect(n.port.drive).toHaveBeenCalledTimes(2);
    const blind = native({head: 0});
    await expect(reason(run(cp, session().value, blind.port))).resolves.toBe("unavailable:log_head_unknown");
    expect(blind.port.unlockConsuming).not.toHaveBeenCalled();
  });
  it("a strict pin discovered natively reads unlock_strict", async () => {
    const cp = await controlPlane(), n = native();
    (n.port.unlockConsuming as ReturnType<typeof vi.fn>).mockImplementationOnce((secret: Uint8Array) => {secret.fill(0); throw new AppStrictDeviceApprovalError();});
    await expect(reason(run(cp, session().value, n.port))).resolves.toBe("unlock_strict");
  });
  it("a native failure that is not a typed refusal ends the call untyped: it is never shown as a retryable problem", async () => {
    const cp = await controlPlane(), n = native(), lost = new Error("runtime retired");
    (n.port.unlockConsuming as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {throw lost;});
    await expect(run(cp, session().value, n.port)).rejects.toBe(lost);
  });
  it("cancellation and a lost session reject untyped", async () => {
    const cp = await controlPlane(), stop = new AbortController(), n = native();
    (n.port.drive as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {stop.abort();});
    await expect(reason(run(cp, session().value, n.port, {password: PASSWORD}, {signal: stop.signal}))).resolves.toMatch(/^other:/);
    const s = session(), m = native();
    (m.port.drive as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {s.end();});
    await expect(reason(run(cp, s.value, m.port))).resolves.toMatch(/^other:/);
  });
  it("refuses a malformed secret object before any request", async () => {
    const cp = await controlPlane(), n = native();
    await expect(reason(run(cp, session().value, n.port, {} as never))).resolves.toBe("unavailable:binding");
    await expect(reason(run(cp, session().value, n.port, {password: PASSWORD, recoveryKey: "x"} as never))).resolves.toBe("unavailable:binding");
    await expect(reason(run(cp, session().value, n.port, {password: 7} as never))).resolves.toBe("unavailable:binding");
    expect(cp.calls).toHaveLength(0);
  });
});

const STATUS = "GET /v1/next/account-key/status", FETCH = ["POST /v1/next/devices/challenge", "GET /v1/next/account-key"];
describe("the account-wide bundle fetch budget across unlock attempts", () => {
  it("a malformed recovery key is refused locally: no status read, no challenge, no bundle fetch, and a held bundle is left as it was", async () => {
    const cp = await controlPlane(), n = native(), sealed = new AppAccountKeySealedBundle();
    for (const recoveryKey of ["not a recovery key", "", "MDB1-000G4-0R40M-30E20", formatRecoveryKey(R).slice(0, -1) + (formatRecoveryKey(R).endsWith("0") ? "1" : "0")])
      await expect(reason(run(cp, session().value, n.port, {recoveryKey}, {sealed}))).resolves.toMatch(/^invalid_recovery_key/);
    await expect(reason(run(cp, session().value, n.port, {recoveryKey: "nope"}))).resolves.toMatch(/^invalid_recovery_key/);
    expect(cp.calls).toHaveLength(0);
    expect(n.port.signFetch).not.toHaveBeenCalled(); expect(n.port.unlockConsuming).not.toHaveBeenCalled();
    // With a bundle already held, a mistyped key neither uses nor drops it.
    await expect(reason(run(cp, session().value, n.port, {password: "a wrong password"}, {sealed}))).resolves.toBe("wrong_secret");
    expect(sealed.holding).toBe(true); const before = cp.calls.length;
    await expect(reason(run(cp, session().value, n.port, {recoveryKey: "MDB1-nope"}, {sealed}))).resolves.toMatch(/^invalid_recovery_key/);
    expect(sealed.holding).toBe(true); expect(cp.calls).toHaveLength(before);
  });
  it("a password outside the length policy opens no bundle: wrong_secret locally, without a request", async () => {
    const cp = await controlPlane(), n = native(), sealed = new AppAccountKeySealedBundle();
    for (const password of ["", "short", "elevenchars", "x".repeat(5000)])
      await expect(reason(run(cp, session().value, n.port, {password}, {sealed}))).resolves.toBe("wrong_secret");
    expect(cp.calls).toHaveLength(0); expect(sealed.holding).toBe(false);
    expect(n.port.signFetch).not.toHaveBeenCalled(); expect(n.port.unlockConsuming).not.toHaveBeenCalled();
  });
  it("wrong secrets in one locked session spend one bundle fetch: later attempts read status only, and the right secret then unlocks", async () => {
    const cp = await controlPlane(), s = session(), n = native(), sealed = new AppAccountKeySealedBundle();
    await expect(reason(run(cp, s.value, n.port, {password: "correct horse battery stapl3"}, {sealed}))).resolves.toBe("wrong_secret");
    expect(cp.paths()).toEqual([STATUS, ...FETCH]); expect(sealed.holding).toBe(true);
    await expect(reason(run(cp, s.value, n.port, {password: "another wrong one"}, {sealed}))).resolves.toBe("wrong_secret");
    await expect(reason(run(cp, s.value, n.port, {recoveryKey: formatRecoveryKey(counter(4)(32))}, {sealed}))).resolves.toBe("wrong_secret");
    expect(cp.paths()).toEqual([STATUS, ...FETCH, STATUS, STATUS]); expect(sealed.holding).toBe(true);
    expect(n.port.unlockConsuming).not.toHaveBeenCalled();
    await run(cp, s.value, n.port, {password: PASSWORD}, {sealed});
    expect(cp.paths()).toEqual([STATUS, ...FETCH, STATUS, STATUS, STATUS]);
    expect(n.loans.map(loan => loan.seen)).toEqual([toHex(R)]); expect(n.port.status().state).toBe("keyed");
    // Unlocked: nothing is kept.
    expect(sealed.holding).toBe(false);
  });
  it("without a holder every attempt fetches, as before", async () => {
    const cp = await controlPlane(), s = session(), n = native();
    await expect(reason(run(cp, s.value, n.port, {password: "a wrong password"}))).resolves.toBe("wrong_secret");
    await expect(reason(run(cp, s.value, n.port, {password: "a wrong password again"}))).resolves.toBe("wrong_secret");
    expect(cp.paths()).toEqual([STATUS, ...FETCH, STATUS, ...FETCH]);
  });
  it("a password changed on another device is fetched afresh: the held bundle is used only for the version and key id status reports", async () => {
    const cp = await controlPlane(), s = session(), n = native(), sealed = new AppAccountKeySealedBundle();
    await expect(reason(run(cp, s.value, n.port, {password: "the new password, typed early"}, {sealed}))).resolves.toBe("wrong_secret");
    const rewrapped = await sealBundle(R, "the new password, typed early", ACCOUNT, {entropy: counter(5), argon2id: fastKdf});
    cp.row.version = 2; cp.row.bundle = toHex(encodeBundle(rewrapped));
    await run(cp, s.value, n.port, {password: "the new password, typed early"}, {sealed});
    expect(cp.paths()).toEqual([STATUS, ...FETCH, STATUS, ...FETCH]);
    expect(n.loans.map(loan => loan.seen)).toEqual([toHex(R)]); expect(sealed.holding).toBe(false);
  });
  it.each([
    ["status carries no version", (cp: Awaited<ReturnType<typeof controlPlane>>) => { cp.state.statusBody = {mode: "password", key_id: cp.row.key_id}; }],
    ["status carries no key id", (cp: Awaited<ReturnType<typeof controlPlane>>) => { cp.state.statusBody = {mode: "password", version: 1}; }],
    ["status names another key id", (cp: Awaited<ReturnType<typeof controlPlane>>) => { cp.state.statusBody = {mode: "password", version: 1, key_id: "ab".repeat(32)}; }],
    ["status carries a malformed version", (cp: Awaited<ReturnType<typeof controlPlane>>) => { cp.state.statusBody = {mode: "password", version: "1", key_id: cp.row.key_id}; }],
  ] as const)("never reuses a held bundle when %s", async (_name, change) => {
    const cp = await controlPlane(), s = session(), n = native(), sealed = new AppAccountKeySealedBundle();
    await expect(reason(run(cp, s.value, n.port, {password: "a wrong password"}, {sealed}))).resolves.toBe("wrong_secret");
    change(cp);
    await expect(reason(run(cp, s.value, n.port, {password: "a wrong password again"}, {sealed}))).resolves.toBe("wrong_secret");
    expect(cp.paths()).toEqual([STATUS, ...FETCH, STATUS, ...FETCH]);
  });
  it("a held bundle belongs to one account, connector and device", async () => {
    const cp = await controlPlane(), sealed = new AppAccountKeySealedBundle(), held = {accountId: ACCOUNT, connectorId: CONNECTOR, deviceId: DEVICE};
    sealed.keep(held, cp.row);
    for (const other of [{...held, accountId: COLLECTION}, {...held, connectorId: COLLECTION}, {...held, deviceId: COLLECTION}]) {
      expect(sealed.take(other, 1, cp.row.key_id)).toBeNull(); expect(sealed.holding).toBe(false); sealed.keep(held, cp.row);
    }
    expect(sealed.take(held, 1, cp.row.key_id)).toEqual(cp.row);
    for (const answer of [{mode: "strict", version: 2}, {mode: "none", version: 0}, {...cp.row, bundle: "zz"}, {...cp.row, key_id: "short"}, {...cp.row, version: 0}, null, [cp.row]]) {
      sealed.keep(held, answer); expect(sealed.holding).toBe(false);
    }
    sealed.keep(held, cp.row); sealed.clear(); expect(sealed.holding).toBe(false);
  });
  it("only a wrong secret keeps the bundle: a strict or absent account key, a refused grant, a lost session and a cancelled call all drop it", async () => {
    const cp = await controlPlane(), sealed = new AppAccountKeySealedBundle();
    const hold = async () => { cp.state.mode = "password"; await expect(reason(run(cp, session().value, native().port, {password: "a wrong password"}, {sealed}))).resolves.toBe("wrong_secret"); expect(sealed.holding).toBe(true); };
    await hold(); cp.state.mode = "strict";
    await expect(reason(run(cp, session().value, native().port, {password: PASSWORD}, {sealed}))).resolves.toBe("unlock_strict"); expect(sealed.holding).toBe(false);
    await hold(); cp.state.mode = "none";
    await expect(reason(run(cp, session().value, native().port, {password: PASSWORD}, {sealed}))).resolves.toBe("no_account_key"); expect(sealed.holding).toBe(false);
    await hold();
    await expect(reason(run(cp, session().value, native({unlocked: {state: "refused", reason: "not_authorized"}}).port, {password: PASSWORD}, {sealed}))).resolves.toBe("unlock_failed:not_authorized"); expect(sealed.holding).toBe(false);
    await hold(); cp.state.statusStatus = 503;
    await expect(reason(run(cp, session().value, native().port, {password: PASSWORD}, {sealed}))).resolves.toMatch(/^unavailable/); expect(sealed.holding).toBe(false);
    cp.state.statusStatus = 200; await hold();
    const ended = session(); ended.end();
    await expect(reason(run(cp, ended.value, native().port, {password: PASSWORD}, {sealed}))).resolves.toMatch(/^other:/);
    await hold();
    const abort = new AbortController(); abort.abort();
    await expect(reason(run(cp, session().value, native().port, {password: PASSWORD}, {sealed, signal: abort.signal}))).resolves.toMatch(/^other:/);
    await hold();
    // Already keyed: nothing to unlock, nothing kept.
    await run(cp, session().value, native({start: {state: "keyed"}}).port, {password: PASSWORD}, {sealed}); expect(sealed.holding).toBe(false);
  });
});

describe("AppCpAccountKeyControl", () => {
  const control = (cp: {fetch: typeof fetch}, s = session().value, sign: (challenge: Uint8Array) => Uint8Array = () => SIGNATURE.slice(), extra = {}) =>
    new AppCpAccountKeyControl(s, sign, {fetch: cp.fetch, ...extra});
  const code = (work: Promise<unknown>) => work.then(() => "ok", error => error instanceof AccountKeyError ? `${error.code}:${error.reason ?? ""}` : `other:${JSON.stringify(error)}`);
  it("refuses setup, password change, strict mode and recovery-device enrolment without a request", async () => {
    const cp = await controlPlane(), port = control(cp);
    await expect(code(port.put())).resolves.toBe("unavailable:not_supported");
    await expect(code(port.strict())).resolves.toBe("unavailable:not_supported");
    await expect(code(port.enrolRecoveryDevice())).resolves.toBe("unavailable:not_supported");
    expect(cp.calls).toHaveLength(0);
  });
  it("binds to an https control plane, a current session and non-nil ids", async () => {
    const cp = await controlPlane();
    expect(() => control(cp, session({cpOrigin: "http://cp.example.test"}).value)).toThrow(AccountKeyError);
    expect(() => control(cp, session({cpOrigin: "https://cp.example.test/path"}).value)).toThrow(AccountKeyError);
    expect(() => control(cp, session({deviceId: "00000000-0000-0000-0000-000000000000"}).value)).toThrow(AccountKeyError);
    expect(() => control(cp, session({isCurrent: () => false}).value)).toThrow(AccountKeyError);
    expect(() => control(cp, session({cpOrigin: "http://127.0.0.1:8787"}).value)).toThrow(AccountKeyError);
  });
  it("refuses a malformed, expired or far-future challenge before signing", async () => {
    const cp = await controlPlane(), sign = vi.fn(() => SIGNATURE.slice()), port = control(cp, session().value, sign);
    for (const body of [{challenge: "zz", expires_at: Date.now() + 60_000}, {challenge: "ab".repeat(32), expires_at: Date.now() + 1_000},
      {challenge: "ab".repeat(32), expires_at: Date.now() + 3_600_000}, {challenge: "AB".repeat(32), expires_at: Date.now() + 60_000}, {challenge: "ab".repeat(32)}]) {
      cp.state.challengeBody = body;
      await expect(code(port.fetch({}))).resolves.toBe("unavailable:response");
    }
    expect(sign).not.toHaveBeenCalled();
    expect(cp.paths().filter(path => path === "GET /v1/next/account-key")).toHaveLength(0);
  });
  it("refuses a signature that is not 64 bytes, and maps a missing signer", async () => {
    const cp = await controlPlane();
    await expect(code(control(cp, session().value, () => new Uint8Array(63)).fetch({}))).resolves.toBe("unavailable:proof");
    await expect(code(control(cp, session().value, () => { throw new AppAccountKeyProofUnavailableError(); }).fetch({}))).resolves.toBe("unavailable:account_key_proof_unavailable");
    await expect(code(control(cp, session().value, () => { throw new AppStrictDeviceApprovalError(); }).fetch({}))).resolves.toBe("strict_mode:");
    await expect(code(control(cp, session().value, () => { throw new Error("native"); }).fetch({}))).resolves.toBe("unavailable:proof");
    expect(cp.paths().filter(path => path === "GET /v1/next/account-key")).toHaveLength(0);
  });
  it("refuses an unusable bearer, an oversized body and a request after close", async () => {
    const cp = await controlPlane();
    await expect(code(control(cp, session({connectorBearer: async () => "has space"}).value).status({}))).resolves.toBe("unavailable:binding");
    expect(cp.calls).toHaveLength(0);
    const big = vi.fn(async () => new Response("x".repeat(70_000), {status: 200})) as unknown as typeof fetch;
    await expect(code(control({fetch: big}).status({}))).resolves.toBe("unavailable:response");
    const port = control(cp); port.close();
    await expect(code(port.status({}))).resolves.toBe("cancelled:");
  });
  it("fences a session that stops being current between the bearer and the request", async () => {
    const cp = await controlPlane(), s = session();
    const port = control(cp, {...s.value, connectorBearer: async () => {s.end(); return BEARER;}});
    await expect(code(port.status({}))).resolves.toBe("unavailable:fenced");
    expect(cp.calls).toHaveLength(0);
  });
});
