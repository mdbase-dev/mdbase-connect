// mdbase-next transport for MCP tool calls: the connector is an ordinary thin client.
// It resolves the collection's route on the control plane, opens a Noise session to
// the hosted replica (cloud copy) or a user device through the relay (Private), and
// runs the tool there. Collections the control plane does not route stay on the
// legacy authority path until it is removed.
import { connect, controlRouteResolver, describeError, isMdbaseError, routeFromControl, uuidv7, type KeyPair, type MdbaseClient, type RecordView, type Write } from "@mdbase-dev/sdk";
import type { GrantKeyStore } from "@mdbase-dev/connect/crypto";
import { GatewayOperationError } from "./errors.js";
import { gatewayConnector } from "./next-connector.js";
import { clientKeyAttachBody, type NoiseKeyStore } from "./next-keys.js";
import {
  changesInput, changesOutput, collectionDescription, contractQueryOutput, implementationDigests, nextQueryPlan, queryOutput,
  recordDocument, typeDocument, validationOutput
} from "./next-mapping.js";

export interface NextConnection {
  id: string;
  upstream_url: string;
  collection_id: string;
  display_name: string;
  operations: string[];
  key_handle: string | null;
  native?: { collection: string; authorizationGrant: string };
}

interface Session {
  client: MdbaseClient;
  token: { value: string };
  idle: ReturnType<typeof setTimeout> | null;
  keyHandle: string | null;
  /** The routing grant the session was opened under. */
  grant: string;
  /** Served by the hosted replica (cloud copy), not a user device. */
  hosted: boolean;
  /** Closed by the gateway: never handed out again. */
  ended: boolean;
}

/** What a write is about, kept so that running it again is the same write. */
interface WriteMemo {
  /** The record ID a create mints. */
  createId: string;
  /** The record a rename found at its old path the first time. */
  recordId?: string;
  expires: number;
}

/** The legacy authority path should serve this call. */
export const LEGACY = Symbol("legacy");
const LEGACY_TTL_MS = 60_000;
const IDLE_MS = 5 * 60_000;
const WRITE_TIMEOUT_MS = 30_000;
// A hosted replica serves a session only while it can prove it is current. Until it
// has applied a new grant's policy item (a few seconds after Connect lists it), and
// whenever it is catching up with the log, it closes sessions without a reason:
// during the handshake, or under a running call. Clients are expected to come back.
// An open waits that out for about 20 s in all; a connection whose wait ran out does
// not wait again until it has opened.
const HOSTED_GRACE_DELAYS_MS = [1_000, 2_000, 3_000, 4_000, 5_000, 5_000];
// How often one tool call is run again after the hosted replica closed its session,
// and how long after the call began a rerun may still start.
const HOSTED_RETRIES = 2;
const HOSTED_RERUN_WITHIN_MS = 30_000;
// Route refusals that say the grant no longer stands. A session open under it ends;
// any other failure (Connect out of reach or erroring, an expired access token) only
// fails the call that met it.
const GRANT_REFUSALS = new Set(["reconnect_required", "access_removed", "sync_required", "authorization_changed"]);
// A client told to retry a write with the same mutation_id does so within minutes.
const WRITE_MEMO_TTL_MS = 15 * 60_000;
const WRITE_MEMO_MAX = 4_096;
const NO_MEMO: WriteMemo = { createId: "", expires: 0 };

export class NextGateway {
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly legacy = new Map<string, number>();
  /** Connections whose last hosted open used up its grace without opening. */
  private readonly hostedSpent = new Set<string>();
  /** By connection and mutation ID; in insertion order, so the oldest entry comes first. */
  private readonly writes = new Map<string, WriteMemo>();
  private readonly fetch: typeof fetch;

  constructor(private readonly options: {
    keyStore: GrantKeyStore;
    noise: NoiseKeyStore;
    version: string;
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    open?: (input: { connection: NextConnection; grant: string; key: KeyPair; token: { value: string }; resolveRoute?: ReturnType<typeof controlRouteResolver> }) => Promise<MdbaseClient>;
  }) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** Run one tool operation on next, or return LEGACY. */
  async run(connection: NextConnection, accessToken: string, operation: string, input: Record<string, unknown>, requestId: string, signal?: AbortSignal): Promise<unknown> {
    if (!connection.native && (this.legacy.get(connection.id) ?? 0) > this.now()) return LEGACY;
    const started = this.now();
    const memo = operation === "create" || operation === "rename" ? this.memo(`${connection.id}:${requestId}`) : NO_MEMO;
    for (let retry = 0; ; retry++) {
      const session = await this.session(connection, accessToken, signal);
      if (session === LEGACY) return LEGACY;
      try {
        return await execute(session.client, connection, operation, input, requestId, memo, signal);
      } catch (error) {
        if (isMdbaseError(error) && (error.code === "unavailable" || error.code === "unauthenticated")) this.end(connection.id, session);
        // The hosted replica closed the session under the call. Reopen and run it
        // again: a write keeps its mutation ID, so it is not applied twice.
        const closed = session.hosted && isMdbaseError(error, "unavailable") && !error.reason;
        const again = closed && retry < HOSTED_RETRIES && !signal?.aborted && this.now() - started < HOSTED_RERUN_WITHIN_MS;
        if (!again) throw gatewayError(error, !!connection.native);
      } finally {
        this.touch(connection.id, session);
      }
    }
  }

  /** This mutation's memo: the one an earlier attempt left, or a new one. */
  private memo(key: string): WriteMemo {
    const now = this.now();
    const known = this.writes.get(key);
    if (known && known.expires > now) return known;
    for (const [id, entry] of this.writes) {
      if (entry.expires > now && this.writes.size < WRITE_MEMO_MAX) break;
      this.writes.delete(id);
    }
    const memo = { createId: uuidv7(), expires: now + WRITE_MEMO_TTL_MS };
    this.writes.set(key, memo);
    return memo;
  }

  private async session(connection: NextConnection, accessToken: string, signal?: AbortSignal): Promise<Session | typeof LEGACY> {
    // Connect authorizes every call, as it does on the legacy path. A replica learns of
    // a revoked grant from the log, seconds later; an open session must not outlive
    // the grant for that long.
    let route: Awaited<ReturnType<NextGateway["route"]>>;
    try {
      route = await this.route(connection, accessToken, true, signal);
    } catch (error) {
      if (error instanceof GatewayOperationError && GRANT_REFUSALS.has(error.code)) this.drop(connection.id);
      throw error;
    }
    if (route === LEGACY) {
      this.drop(connection.id);
      this.legacy.set(connection.id, this.now() + LEGACY_TTL_MS);
      return LEGACY;
    }
    const existing = this.sessions.get(connection.id);
    if (existing) {
      const session = await abortable(existing.catch(() => null), signal);
      if (session && !session.ended && session.keyHandle === connection.key_handle && session.grant === route.grant) {
        session.token.value = accessToken;
        return session;
      }
      // Another call may have replaced it while this one waited.
      if (this.sessions.get(connection.id) === existing) {
        this.sessions.delete(connection.id);
        if (session) this.end(connection.id, session);
      } else {
        return this.session(connection, accessToken, signal);
      }
    }
    const token = { value: accessToken };
    const opening = (async () => {
      const key = await this.options.noise.get(connection.key_handle!);
      if (!key) throw GatewayOperationError.reconnectRequired(connection);
      // The SDK reports a route it could not resolve as a replica it could not reach.
      // Keep what Connect said, so that the open neither waits on it nor hides it.
      let refused: unknown = null;
      const resolveRoute = connection.native ? async () => {
        try {
          const current = await this.route(connection, token.value, false);
          if (current === LEGACY) throw new GatewayOperationError("control_error", "Native collection routing is unavailable.");
          if (current.grant !== route.grant) throw new GatewayOperationError("authorization_changed", "Connect returned a different routing grant.");
          return routeFromControl({ collection: connection.collection_id, ...current }, token.value);
        } catch (error) {
          refused = error;
          throw error;
        }
      } : undefined;
      const open = this.options.open ?? openClient(this.fetch, this.options.version);
      const hosted = route.targets[0]?.kind === "hosted";
      const client = await this.openWithGrace(connection, hosted, async () => {
        refused = null;
        try {
          return await open({ connection, grant: route.grant, key, token, ...(resolveRoute ? { resolveRoute } : {}) });
        } catch (error) {
          throw refused ?? error;
        }
      });
      return { client, token, idle: null, keyHandle: connection.key_handle, grant: route.grant, hosted, ended: false } satisfies Session;
    })();
    this.sessions.set(connection.id, opening);
    // Callers share the open; one that gives up leaves it running for the others.
    opening.catch(() => { if (this.sessions.get(connection.id) === opening) this.sessions.delete(connection.id); });
    try {
      return await abortable(opening, signal);
    } catch (error) {
      throw gatewayError(error, !!connection.native);
    }
  }

  /**
   * Open a session; on a hosted route, retry a session the replica closed during the
   * handshake while it cannot serve this grant yet. Each attempt resolves the route
   * again, so a revoked or changed grant ends the wait at once. A Worker that cannot
   * be reached at all looks the same from here and is waited for as well.
   */
  private async openWithGrace(connection: NextConnection, hosted: boolean, open: () => Promise<MdbaseClient>): Promise<MdbaseClient> {
    if (!hosted) return open();
    const delays = this.hostedSpent.has(connection.id) ? [] : HOSTED_GRACE_DELAYS_MS;
    for (const delay of delays) {
      try {
        const client = await open();
        this.hostedSpent.delete(connection.id);
        return client;
      } catch (error) {
        // A close during the handshake carries no reason; route and relay refusals do.
        if (!isMdbaseError(error, "unavailable") || error.reason) throw error;
        await (this.options.sleep ?? sleep)(delay);
      }
    }
    this.hostedSpent.add(connection.id);
    const client = await open();
    this.hostedSpent.delete(connection.id);
    return client;
  }

  /** `GET /v1/next/collections/:id/route`; attaches a Noise key once if the grant has none. */
  private async route(connection: NextConnection, accessToken: string, attach: boolean, signal?: AbortSignal): Promise<{ grant: string; targets: Parameters<typeof routeFromControl>[0]["targets"] } | typeof LEGACY> {
    const url = `${new URL(connection.upstream_url).origin}/v1/next/collections/${encodeURIComponent(connection.collection_id)}/route`;
    let response: Response;
    try {
      response = await this.fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, redirect: "error", signal });
    } catch {
      throw new GatewayOperationError("control_unreachable", "Connect could not be reached. Try again shortly.");
    }
    const body = await response.json().catch(() => null) as RouteBody | null;
    if (!connection.native && (response.status === 404 || response.status === 405)) return LEGACY;
    if (response.status === 401) throw new GatewayOperationError("authority_authentication_expired", "Connect access expired.");
    if (!connection.native && response.status === 409 && body?.error?.code === "client_key_required" && attach) {
      if (await this.attach(connection, accessToken, body.error.details, signal)) return this.route(connection, accessToken, false, signal);
      throw GatewayOperationError.reconnectRequired(connection);
    }
    if (response.status === 409) throw GatewayOperationError.reconnectRequired(connection);
    if (!response.ok || typeof body?.grant !== "string" || !Array.isArray(body.targets)) {
      throw new GatewayOperationError(body?.error?.code ?? "control_error", `Connect could not route ${connection.display_name}.`);
    }
    if (connection.native) validateNativeRoute(connection, body);
    // A grant superseded by, or removed from, a next collection: the legacy path
    // would only answer that the collection moved. A new approval is the remedy.
    const reason = body.availability?.state === "unavailable" ? body.availability.reason : undefined;
    if (reason === "sync_required" || reason === "access_removed") throw GatewayOperationError.reconnectRequired(connection);
    // No target: not served by mdbase-next (yet). The legacy path answers.
    if (body.targets.length === 0) return LEGACY;
    return { grant: body.grant, targets: body.targets };
  }

  private async attach(connection: NextConnection, accessToken: string, details: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<boolean> {
    const grantId = details?.grant_id, authorizationId = details?.authorization_id;
    if (typeof grantId !== "string" || typeof authorizationId !== "string" || !connection.key_handle) return false;
    const grantKey = await this.options.keyStore.get(connection.key_handle);
    if (!grantKey) return false;
    const noise = await this.options.noise.get(connection.key_handle) ?? await this.options.noise.create(connection.key_handle);
    const response = await this.fetch(`${new URL(connection.upstream_url).origin}/v1/next/grants/client-key`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(await clientKeyAttachBody(grantKey, grantId, authorizationId, noise, this.now())),
      redirect: "error",
      signal
    }).catch(() => null);
    return response?.ok === true;
  }

  private touch(id: string, session: Session): void {
    if (session.ended) return;
    if (session.idle) clearTimeout(session.idle);
    session.idle = setTimeout(() => this.end(id, session), IDLE_MS);
    session.idle.unref?.();
  }

  /** Close this session, and forget it if it is still the connection's session. */
  private end(id: string, session: Session): void {
    if (session.ended) return;
    session.ended = true;
    if (session.idle) clearTimeout(session.idle);
    session.client.close();
    const current = this.sessions.get(id);
    void current?.then((value) => { if (value === session && this.sessions.get(id) === current) this.sessions.delete(id); }, () => undefined);
  }

  /** Close whatever session the connection has. */
  drop(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    void session?.then((value) => this.end(id, value), () => undefined);
  }

  close(): void {
    for (const id of [...this.sessions.keys()]) this.drop(id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
}

/** `promise`, unless the caller gives up first. The work behind it carries on. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const cancelled = () => new GatewayOperationError("cancelled", "The call was cancelled.");
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function openClient(fetchImpl: typeof fetch, version: string) {
  return async ({ connection, grant, key, token, resolveRoute: nativeRoute }: { connection: NextConnection; grant: string; key: KeyPair; token: { value: string }; resolveRoute?: ReturnType<typeof controlRouteResolver> }) => {
    const resolveRoute = nativeRoute ?? controlRouteResolver({
      server: new URL(connection.upstream_url).origin,
      collection: connection.collection_id,
      accessToken: () => token.value,
      fetch: fetchImpl
    });
    return connect({
      connector: gatewayConnector({ collection: connection.collection_id, grant, staticKey: key, resolveRoute }),
      app: { name: "dev.mdbase.mcp", version },
      reconnect: false
    });
  };
}

async function execute(client: MdbaseClient, connection: NextConnection, operation: string, input: Record<string, unknown>, requestId: string, memo: WriteMemo, signal?: AbortSignal): Promise<unknown> {
  const write = { mutationId: requestId, wait: "confirmed" as const, include: { effective: true, body: true }, ...(signal ? { signal } : {}) };
  switch (operation) {
    case "describe": {
      const [description, cursor] = await Promise.all([client.describe({ definitions: true, ...(signal ? { signal } : {}) }), client.changes(undefined, 1, signal)]);
      return collectionDescription({ collectionId: connection.collection_id, displayName: connection.display_name, operations: connection.operations, changeCursor: cursor.cursor }, description);
    }
    case "changes": {
      const { cursor, limit } = changesInput(input as { after?: number | string; limit?: number });
      return changesOutput(await client.changes(cursor, limit, signal), limit);
    }
    case "query": {
      if (typeof input.release_cursor === "string") return { released: true };
      const plan = nextQueryPlan(input);
      if (plan.kind === "contract") {
        const [result, description] = await Promise.all([
          client.queryContract(plan.contract, {
            ...(plan.pageSize ? { pageSize: plan.pageSize } : {}), ...(plan.cursor ? { cursor: plan.cursor } : {}),
            ...(plan.where ? { where: plan.where } : {}), ...(signal ? { signal } : {})
          }),
          client.describe(signal ? { signal } : {})
        ]);
        return contractQueryOutput(plan, result, implementationDigests(plan.contract, description));
      }
      return queryOutput(plan, await client.query(plan.query as Parameters<MdbaseClient["query"]>[0], plan.include, signal));
    }
    case "read":
      return recordDocument(await read(client, String(input.path), signal));
    case "validate":
      return validationOutput(await client.validate(undefined, signal));
    case "read_type": {
      const type = await findType(client, input, signal);
      return typeDocument(type.name, await client.resources.get(type.path, signal));
    }
    case "create": {
      const id = memo.createId;
      const created = await settle(client.create({
        id,
        ...(typeof input.path === "string" ? { path: input.path } : {}),
        ...(typeof input.type === "string" ? { type: input.type } : {}),
        ...(input.frontmatter ? { frontmatter: input.frontmatter as Record<string, never> } : {}),
        ...(typeof input.body === "string" ? { body: input.body } : {})
      }, write), () => client.find(id, RECORD_VIEW, signal));
      return recordDocument(created);
    }
    case "update": {
      const current = await read(client, String(input.path), signal, true);
      if (typeof input.document === "string") {
        if (input.patch !== undefined || input.body !== undefined) throw new GatewayOperationError("invalid_request", "document cannot be combined with patch or body.");
        return { ...recordDocument(await settle(client.replaceDocument(current, input.document, { ...write, ...(typeof input.if_revision === "string" ? { ifRevision: input.if_revision } : {}) }), () => client.find(current.id, RECORD_VIEW, signal))) };
      }
      return recordDocument(await settle(client.update(current, {
        ...(input.patch ? { patch: input.patch as Record<string, never> } : {}),
        ...(typeof input.body === "string" ? { body: input.body } : {}),
        ...(typeof input.if_revision === "string" ? { ifRevision: input.if_revision } : {})
      }, write), () => client.find(current.id, RECORD_VIEW, signal)));
    }
    case "delete": {
      const current = await find(client, String(input.path), signal);
      if (!current) {
        // Run again after its answer was lost: the record is already gone.
        if (await confirmedBefore(client, requestId, signal)) return { path: String(input.path), deleted: true };
        throw notFound(String(input.path));
      }
      const broken = input.check_backlinks === true ? (await client.preflightDelete(current)).broken : [];
      await settle(client.delete(current, { ...write, ...(typeof input.if_revision === "string" ? { ifRevision: input.if_revision } : {}) }), null);
      return { path: current.path, deleted: true, ...(broken.length ? { brokenLinks: broken.map((link) => ({ path: link.path })) } : {}) };
    }
    case "rename": {
      const current = await find(client, String(input.from), signal);
      if (!current) {
        // Run again after its answer was lost: the record is already at its new path.
        // By ID when an earlier attempt saw it; the replica may have normalized the path.
        const moved = !await confirmedBefore(client, requestId, signal) ? null
          : memo.recordId ? await client.find(memo.recordId, RECORD_VIEW, signal) : await find(client, String(input.to), signal);
        if (!moved) throw notFound(String(input.from));
        return { ...recordDocument(moved), from: String(input.from), to: moved.path };
      }
      memo.recordId = current.id;
      const renamed = await settle(client.rename(current, String(input.to), {
        ...write, updateRefs: input.update_refs !== false, ...(typeof input.if_revision === "string" ? { ifRevision: input.if_revision } : {})
      }), () => client.find(current.id, RECORD_VIEW, signal));
      return { ...recordDocument(renamed), from: current.path, to: renamed.path };
    }
    case "create_type": {
      const document = String(input.document);
      if (typeof input.path === "string") {
        await settle(client.resources.put(input.path, document, { ...write, mustNotExist: true }), null);
        const resource = await client.resources.get(input.path, signal);
        return typeDocument(input.path.replace(/^.*\//u, "").replace(/\.md$/u, ""), resource);
      }
      const created = await client.createType(document, write);
      await settle(Promise.resolve(created.write), null);
      return typeDocument(created.name, await client.resources.get(created.path, signal));
    }
    case "update_type": {
      const type = await findType(client, input, signal);
      await settle(client.resources.put(type.path, String(input.document), { ...write, baseRevision: String(input.if_revision) }), null);
      return typeDocument(type.name, await client.resources.get(type.path, signal));
    }
    default:
      throw new GatewayOperationError("unsupported_operation", `${operation} is not available for this collection.`);
  }
}

async function read(client: MdbaseClient, path: string, signal?: AbortSignal, document = false): Promise<RecordView> {
  const view = await find(client, path, signal, document);
  if (!view) throw notFound(path);
  return view;
}

function find(client: MdbaseClient, path: string, signal?: AbortSignal, document = false): Promise<RecordView | null> {
  return client.find({ path }, { effective: true, body: true, ...(document ? { document: true } : {}) }, signal);
}

function notFound(path: string): GatewayOperationError {
  return new GatewayOperationError("record_not_found", `No record at ${path}.`);
}

/**
 * Whether the replica already confirmed this mutation: the call is being run again
 * after the session closed under it, or the client retried with the same mutation_id.
 * A mutation still pending is waited for, as its first submission would have been.
 */
async function confirmedBefore(client: MdbaseClient, mutationId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    let receipt = await client.receipt(mutationId, signal);
    if (receipt.state === "pending") receipt = await client.awaitReceipt(mutationId, WRITE_TIMEOUT_MS, signal);
    if (receipt.state === "pending") {
      throw new GatewayOperationError("outcome_unknown", "The write was accepted but not yet confirmed. Retry with the same mutation_id to check.");
    }
    return receipt.state === "confirmed";
  } catch (error) {
    if (isMdbaseError(error, "not_found")) return false;
    throw error;
  }
}

async function findType(client: MdbaseClient, input: Record<string, unknown>, signal?: AbortSignal) {
  const description = await client.describe(signal ? { signal } : {});
  const type = description.types.find((candidate) => (typeof input.name === "string" && candidate.name === input.name) || (typeof input.path === "string" && candidate.path === input.path));
  if (!type) throw new GatewayOperationError("type_not_found", "No such type.");
  return type;
}

const RECORD_VIEW = { effective: true, body: true } as const;

/**
 * Hold the write until the log confirms it, then return the resulting record.
 * A replica answers `wait: confirmed` with the settled receipt, which carries no record
 * views (only an immediate pending receipt has them), so the confirmed record is read
 * back from the same replica.
 */
async function settle(pending: Promise<Write>, readBack: () => Promise<RecordView | null>): Promise<RecordView>;
async function settle(pending: Promise<Write>, readBack: null): Promise<null>;
async function settle(pending: Promise<Write>, readBack: (() => Promise<RecordView | null>) | null): Promise<RecordView | null> {
  const write = await pending;
  const receipt = await Promise.race([
    write.confirmed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new GatewayOperationError(
      "outcome_unknown", "The write was accepted but not yet confirmed. Retry with the same mutation_id to check."
    )), WRITE_TIMEOUT_MS).unref?.())
  ]);
  if (!readBack) return null;
  const view = receipt.records?.[0] ?? write.records[0] ?? await readBack();
  if (!view) throw new GatewayOperationError("invalid_operation_response", "The replica confirmed the write without the resulting record.");
  return view;
}

function gatewayError(error: unknown, native = false): unknown {
  if (!isMdbaseError(error)) return error;
  const description = native ? describeError(error) : null;
  return new GatewayOperationError(error.reason ?? error.code, description ? `${description.title}. ${description.message}` : error.message, error.retryAfterMs ? { retry_after_ms: error.retryAfterMs } : undefined);
}

interface RouteBody {
  collection?: unknown;
  grant?: unknown;
  authorization_grant?: unknown;
  targets?: Parameters<typeof routeFromControl>[0]["targets"];
  availability?: { state?: string; reason?: string };
  error?: { code?: string; details?: Record<string, unknown> };
}

function validateNativeRoute(connection: NextConnection, body: RouteBody): void {
  if (body.collection !== connection.native!.collection
    || (body.authorization_grant ?? body.grant) !== connection.native!.authorizationGrant) {
    throw new GatewayOperationError("authorization_changed", "Connect returned a route for a different collection grant.");
  }
  const reason = body.availability?.state === "unavailable" ? body.availability.reason : undefined;
  if (reason || body.targets?.length === 0) {
    const description = describeError({ state: "unavailable", reason: reason ?? "no_device_registered" });
    throw new GatewayOperationError(reason ?? "no_device_registered", description
      ? `${description.title}. ${description.message}` : "This collection is unavailable. Try again shortly.");
  }
}
