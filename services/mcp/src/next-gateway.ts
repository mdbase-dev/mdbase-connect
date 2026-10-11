// mdbase-next transport for MCP tool calls: the connector is an ordinary thin client.
// It resolves the collection's route on the control plane, opens a Noise session to
// the hosted replica (cloud copy) or a user device through the relay (Private), and
// runs the tool there. Collections the control plane does not route stay on the
// legacy authority path until it is removed.
import { connect, controlRouteResolver, isMdbaseError, relayConnector, type KeyPair, type MdbaseClient, type RecordView, type Write } from "@mdbase-dev/sdk";
import type { GrantKeyStore } from "@mdbase-dev/connect/crypto";
import { GatewayOperationError } from "./errors.js";
import { clientKeyAttachBody, type NoiseKeyStore } from "./next-keys.js";
import {
  changesInput, changesOutput, collectionDescription, contractQueryOutput, nextQueryPlan, queryOutput,
  recordDocument, typeDocument, validationOutput
} from "./next-mapping.js";

export interface NextConnection {
  id: string;
  upstream_url: string;
  collection_id: string;
  display_name: string;
  operations: string[];
  key_handle: string | null;
}

interface Session {
  client: MdbaseClient;
  token: { value: string };
  idle: ReturnType<typeof setTimeout> | null;
  keyHandle: string | null;
}

/** The legacy authority path should serve this call. */
export const LEGACY = Symbol("legacy");
const LEGACY_TTL_MS = 60_000;
const IDLE_MS = 5 * 60_000;
const WRITE_TIMEOUT_MS = 30_000;

export class NextGateway {
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly legacy = new Map<string, number>();
  private readonly fetch: typeof fetch;

  constructor(private readonly options: {
    keyStore: GrantKeyStore;
    noise: NoiseKeyStore;
    version: string;
    fetch?: typeof fetch;
    now?: () => number;
    open?: (input: { connection: NextConnection; grant: string; key: KeyPair; token: { value: string } }) => Promise<MdbaseClient>;
  }) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** Run one tool operation on next, or return LEGACY. */
  async run(connection: NextConnection, accessToken: string, operation: string, input: Record<string, unknown>, requestId: string, signal?: AbortSignal): Promise<unknown> {
    if ((this.legacy.get(connection.id) ?? 0) > this.now()) return LEGACY;
    const session = await this.session(connection, accessToken, signal);
    if (session === LEGACY) return LEGACY;
    try {
      return await execute(session.client, connection, operation, input, requestId, signal);
    } catch (error) {
      if (isMdbaseError(error) && (error.code === "unavailable" || error.code === "unauthenticated")) this.drop(connection.id);
      throw gatewayError(error);
    } finally {
      this.touch(connection.id, session);
    }
  }

  private async session(connection: NextConnection, accessToken: string, signal?: AbortSignal): Promise<Session | typeof LEGACY> {
    const existing = this.sessions.get(connection.id);
    if (existing) {
      const session = await existing.catch(() => null);
      if (session && session.keyHandle === connection.key_handle) {
        session.token.value = accessToken;
        return session;
      }
      this.drop(connection.id);
    }
    const route = await this.route(connection, accessToken, true, signal);
    if (route === LEGACY) {
      this.legacy.set(connection.id, this.now() + LEGACY_TTL_MS);
      return LEGACY;
    }
    const token = { value: accessToken };
    const opening = (async () => {
      const key = await this.options.noise.get(connection.key_handle!);
      if (!key) throw reconnectRequired(connection);
      const client = await (this.options.open ?? openClient(this.fetch, this.options.version))({ connection, grant: route.grant, key, token });
      return { client, token, idle: null, keyHandle: connection.key_handle } satisfies Session;
    })();
    this.sessions.set(connection.id, opening);
    try {
      return await opening;
    } catch (error) {
      if (this.sessions.get(connection.id) === opening) this.sessions.delete(connection.id);
      throw gatewayError(error);
    }
  }

  /** `GET /v1/next/collections/:id/route`; attaches a Noise key once if the grant has none. */
  private async route(connection: NextConnection, accessToken: string, attach: boolean, signal?: AbortSignal): Promise<{ grant: string } | typeof LEGACY> {
    const url = `${new URL(connection.upstream_url).origin}/v1/next/collections/${encodeURIComponent(connection.collection_id)}/route`;
    let response: Response;
    try {
      response = await this.fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, redirect: "error", signal });
    } catch {
      throw new GatewayOperationError("control_unreachable", "Connect could not be reached. Try again shortly.");
    }
    const body = await response.json().catch(() => null) as { grant?: unknown; targets?: unknown[]; error?: { code?: string; details?: Record<string, unknown> } } | null;
    if (response.status === 404 || response.status === 405) return LEGACY; // no next control plane
    if (response.status === 401) throw new GatewayOperationError("authority_authentication_expired", "Connect access expired.");
    if (response.status === 409 && body?.error?.code === "client_key_required" && attach) {
      if (await this.attach(connection, accessToken, body.error.details, signal)) return this.route(connection, accessToken, false, signal);
      throw reconnectRequired(connection);
    }
    if (response.status === 409) throw reconnectRequired(connection);
    if (!response.ok || typeof body?.grant !== "string" || !Array.isArray(body.targets)) {
      throw new GatewayOperationError(body?.error?.code ?? "control_error", `Connect could not route ${connection.display_name}.`);
    }
    // No target: not served by mdbase-next (yet). The legacy path answers.
    if (body.targets.length === 0) return LEGACY;
    return { grant: body.grant };
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
    if (session.idle) clearTimeout(session.idle);
    session.idle = setTimeout(() => this.drop(id), IDLE_MS);
    session.idle.unref?.();
  }

  drop(id: string): void {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    void session?.then((value) => { if (value.idle) clearTimeout(value.idle); value.client.close(); }, () => undefined);
  }

  close(): void {
    for (const id of [...this.sessions.keys()]) this.drop(id);
  }
}

function openClient(fetchImpl: typeof fetch, version: string) {
  return async ({ connection, grant, key, token }: { connection: NextConnection; grant: string; key: KeyPair; token: { value: string } }) => {
    const resolveRoute = controlRouteResolver({
      server: new URL(connection.upstream_url).origin,
      collection: connection.collection_id,
      accessToken: () => token.value,
      fetch: fetchImpl
    });
    return connect({
      connector: relayConnector({ collection: connection.collection_id, grant, staticKey: key, resolveRoute }),
      app: { name: "dev.mdbase.mcp", version },
      reconnect: false
    });
  };
}

async function execute(client: MdbaseClient, connection: NextConnection, operation: string, input: Record<string, unknown>, requestId: string, signal?: AbortSignal): Promise<unknown> {
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
        return contractQueryOutput(plan, await client.queryContract(plan.contract, {
          ...(plan.pageSize ? { pageSize: plan.pageSize } : {}), ...(plan.cursor ? { cursor: plan.cursor } : {}),
          ...(plan.where ? { where: plan.where } : {}), ...(signal ? { signal } : {})
        }));
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
      const created = await settle(client.create({
        ...(typeof input.path === "string" ? { path: input.path } : {}),
        ...(typeof input.type === "string" ? { type: input.type } : {}),
        ...(input.frontmatter ? { frontmatter: input.frontmatter as Record<string, never> } : {}),
        ...(typeof input.body === "string" ? { body: input.body } : {})
      }, write));
      return recordDocument(created);
    }
    case "update": {
      const current = await read(client, String(input.path), signal, true);
      if (typeof input.document === "string") {
        if (input.patch !== undefined || input.body !== undefined) throw new GatewayOperationError("invalid_request", "document cannot be combined with patch or body.");
        return { ...recordDocument(await settle(client.replaceDocument(current, input.document, { ...write, ...(typeof input.if_revision === "string" ? { ifRevision: input.if_revision } : {}) }))) };
      }
      return recordDocument(await settle(client.update(current, {
        ...(input.patch ? { patch: input.patch as Record<string, never> } : {}),
        ...(typeof input.body === "string" ? { body: input.body } : {}),
        ...(typeof input.if_revision === "string" ? { ifRevision: input.if_revision } : {})
      }, write)));
    }
    case "delete": {
      const current = await read(client, String(input.path), signal);
      const broken = input.check_backlinks === true ? (await client.preflightDelete(current)).broken : [];
      await settle(client.delete(current, { ...write, ...(typeof input.if_revision === "string" ? { ifRevision: input.if_revision } : {}) }), false);
      return { path: current.path, deleted: true, ...(broken.length ? { brokenLinks: broken.map((link) => ({ path: link.path })) } : {}) };
    }
    case "rename": {
      const current = await read(client, String(input.from), signal);
      const renamed = await settle(client.rename(current, String(input.to), {
        ...write, updateRefs: input.update_refs !== false, ...(typeof input.if_revision === "string" ? { ifRevision: input.if_revision } : {})
      }));
      return { ...recordDocument(renamed), from: current.path, to: renamed.path };
    }
    case "create_type": {
      const document = String(input.document);
      if (typeof input.path === "string") {
        await settle(client.resources.put(input.path, document, { ...write, mustNotExist: true }), false);
        const resource = await client.resources.get(input.path, signal);
        return typeDocument(input.path.replace(/^.*\//u, "").replace(/\.md$/u, ""), resource);
      }
      const created = await client.createType(document, write);
      await settle(Promise.resolve(created.write), false);
      return typeDocument(created.name, await client.resources.get(created.path, signal));
    }
    case "update_type": {
      const type = await findType(client, input, signal);
      await settle(client.resources.put(type.path, String(input.document), { ...write, baseRevision: String(input.if_revision) }), false);
      return typeDocument(type.name, await client.resources.get(type.path, signal));
    }
    default:
      throw new GatewayOperationError("unsupported_operation", `${operation} is not available for this collection.`);
  }
}

async function read(client: MdbaseClient, path: string, signal?: AbortSignal, document = false): Promise<RecordView> {
  const view = await client.find({ path }, { effective: true, body: true, ...(document ? { document: true } : {}) }, signal);
  if (!view) throw new GatewayOperationError("record_not_found", `No record at ${path}.`);
  return view;
}

async function findType(client: MdbaseClient, input: Record<string, unknown>, signal?: AbortSignal) {
  const description = await client.describe(signal ? { signal } : {});
  const type = description.types.find((candidate) => (typeof input.name === "string" && candidate.name === input.name) || (typeof input.path === "string" && candidate.path === input.path));
  if (!type) throw new GatewayOperationError("type_not_found", "No such type.");
  return type;
}

/** Hold the write until the log confirms it, then return the resulting record. */
async function settle(pending: Promise<Write>, record?: true): Promise<RecordView>;
async function settle(pending: Promise<Write>, record: false): Promise<null>;
async function settle(pending: Promise<Write>, record = true): Promise<RecordView | null> {
  const write = await pending;
  const receipt = await Promise.race([
    write.confirmed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new GatewayOperationError(
      "outcome_unknown", "The write was accepted but not yet confirmed. Retry with the same mutation_id to check."
    )), WRITE_TIMEOUT_MS).unref?.())
  ]);
  if (!record) return null;
  const view = receipt.records?.[0] ?? write.records[0];
  if (!view) throw new GatewayOperationError("invalid_operation_response", "The replica confirmed the write without the resulting record.");
  return view;
}

function reconnectRequired(connection: NextConnection): GatewayOperationError {
  return new GatewayOperationError("reconnect_required", `${connection.display_name} needs to be approved again for the updated mdbase.`, { connection_id: connection.id });
}

function gatewayError(error: unknown): unknown {
  if (!isMdbaseError(error)) return error;
  return new GatewayOperationError(error.reason ?? error.code, error.message, error.retryAfterMs ? { retry_after_ms: error.retryAfterMs } : undefined);
}
