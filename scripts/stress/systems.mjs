import { createServer } from "node:net";

const syncModuleUrl = new URL("../../packages/sync/dist/index.js", import.meta.url);

export async function createStressSystem(kind, options) {
  if (kind === "memory") return createMemorySystem(options);
  if (kind === "http") return createHttpSystem(options);
  throw new Error(`Unsupported stress transport ${kind}`);
}

async function createMemorySystem({ collectionId }) {
  const { MemoryAuthority } = await import(syncModuleUrl);
  let authority = new MemoryAuthority({ id: collectionId, snapshotPageSize: 17 });

  return {
    kind: "memory",
    collectionId,
    async createReplica(name, mode = "read_write") {
      const id = authority.registerReplica({ name, mode, allowedTypes: [] });
      return { id, name, mode };
    },
    transportFor(replica) {
      return authority.transport(replica.id);
    },
    async compact(sequence = authority.serialize().head) {
      authority.compactThrough(sequence);
      return sequence;
    },
    async restart() {
      const serialized = authority.serialize();
      authority = MemoryAuthority.restore(serialized, { snapshotPageSize: 17 });
    },
    async revoke(replica) {
      authority.revokeReplica(replica.id);
    },
    async close() {}
  };
}

async function createHttpSystem({ collectionId: _collectionId }) {
  const [{ HttpSyncTransport }, { buildApp }, { createDatabase }] = await Promise.all([
    import(syncModuleUrl),
    import(new URL("../../services/server/dist/app.js", import.meta.url)),
    import(new URL("../../services/server/dist/db.js", import.meta.url))
  ]);
  const database = await createDatabase("memory");
  const port = await availablePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  let app;
  let cookie;
  let collectionId;

  async function start() {
    const built = await buildApp({
      db: database,
      devAuth: true,
      hostedCollections: true,
      hostedReferenceAuthority: true,
      allowInsecureManifests: true,
      publicUrl: serverUrl
    });
    app = built.app;
    await app.listen({ host: "127.0.0.1", port });
  }

  async function request(path, options = {}) {
    const headers = {};
    if (options.cookie ?? cookie) headers.cookie = options.cookie ?? cookie;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${serverUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: AbortSignal.timeout(20_000)
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(value)}`);
    }
    return { response, body: value };
  }

  try {
    await start();
    const session = await request("/v1/dev/session", {
      method: "POST",
      body: { name: "Functional stress", email: "stress@example.test" },
      cookie: null
    });
    cookie = session.response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Stress development session did not set a cookie");
    const created = await request("/v1/hosted/collections", {
      method: "POST",
      body: { display_name: "Functional stress collection", template: "mdbase" }
    });
    collectionId = created.body.collection.id;
  } catch (error) {
    await app?.close().catch(() => {});
    await database.end().catch(() => {});
    throw error;
  }

  return {
    kind: "http",
    collectionId,
    async createReplica(name, mode = "read_write") {
      const created = await request(`/v1/hosted/collections/${collectionId}/replicas`, {
        method: "POST",
        body: { name, mode, allowed_types: [] }
      });
      return {
        id: created.body.replica.id,
        name,
        mode,
        syncUrl: created.body.sync_url,
        token: created.body.token
      };
    },
    transportFor(replica) {
      return new HttpSyncTransport(replica.syncUrl, replica.token);
    },
    async compact(head) {
      await request(`/v1/hosted/collections/${collectionId}/maintenance/compact`, {
        method: "POST",
        body: { through: head }
      });
      return head;
    },
    async restart() {
      await app.close();
      await start();
      await clearStaleHttpConnection(serverUrl);
    },
    async revoke(replica) {
      await request(`/v1/hosted/replicas/${replica.id}`, { method: "DELETE" });
    },
    async close() {
      await app?.close().catch(() => {});
      await database.end().catch(() => {});
    }
  };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a stress-test port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function clearStaleHttpConnection(serverUrl) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(`${serverUrl}/ready`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = new Error(`Restart readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20 * (attempt + 1)));
  }
  throw lastError ?? new Error("Restarted stress server did not become ready");
}
