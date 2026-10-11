import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { registerApplicationRoutes } from "./routes.js";
// The SDK's own registration client, from the vendored runtime source.
import { resolveApplicationRegistration } from "../../../../../runtime/packages/sdk/src/application/registration.js";
import {
  applicationDeclaration,
  rebindApplicationDeclaration,
  type MdbaseApplicationDeclaration
} from "../../../../../runtime/packages/sdk/src/application/declaration.js";

const cpOrigin = "https://cp.example.test";
vi.mock("../../../../../runtime/packages/sdk/src/application/packaged-trust.js", () => ({
  appReleaseTrust: () => ({
    schema: "mdbn-app-trust/release/1",
    environment: "lab",
    cpOrigin,
    logOrigin: "https://log.example.test",
    assetSha256: "aa".repeat(32),
    source: { repository: "mdbase-dev/mdbase-connect", commit: "bb".repeat(20), version: "test" },
    trustedRoots: [new Uint8Array(32).fill(1)],
    policyPins: Uint8Array.of(1)
  })
}));

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;
const origin = "http://127.0.0.1:48218";
const storage = {
  applicationNamespace: "example-web",
  joinDatabaseName: "example.native-collection-join.v1",
  setupDatabaseName: "example.native-model-setup.v1"
};

function manifest(appId: string, redirects = [`${origin}/callback`]) {
  return {
    manifest_version: 1,
    id: appId,
    name: "Example",
    homepage: origin,
    redirect_uris: redirects,
    requirements: { access: "full_collection", contracts: [], capabilities: { contract_version: 2, required: [], optional: [] } }
  };
}

describePg("SDK application registration against the register route", () => {
  let db: DatabasePool;
  let admin: pg.Pool;
  let schema: string;
  const app = Fastify();
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Requires dedicated local test Postgres.");
    schema = `sdk_registration_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    registerErrorHandler(app);
    registerApplicationRoutes(app, { db, allowInsecureManifests: true });
  }, 60_000);
  afterAll(async () => {
    await app.close(); await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  /** The SDK's fetch, answered by the real route. `tamper` edits the CP reply. */
  function cpFetch(tamper?: (application: Record<string, unknown>) => void): typeof fetch {
    return async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(cpOrigin);
      const reply = await app.inject({ method: "POST", url: url.pathname, headers: { "content-type": "application/json" }, payload: String(init!.body) });
      const body = reply.json() as { application: Record<string, unknown> };
      if (tamper && reply.statusCode === 200) tamper(body.application);
      return new Response(JSON.stringify(body), { status: reply.statusCode, headers: { "content-type": "application/json" } });
    };
  }
  function register(declaration: MdbaseApplicationDeclaration, fetch = cpFetch()) {
    const snapshot = applicationDeclaration(declaration);
    return resolveApplicationRegistration({ declaration: snapshot, signal: new AbortController().signal, isCurrent: () => true, fetch })
      .then(registered => ({ registered, snapshot }));
  }
  const rows = async (appId: string) => (await db.query<{ id: string; canonical_identity: string }>(
    "SELECT id::text, canonical_identity FROM applications WHERE family_identity=$1", [`bundle:${appId}`])).rows;
  const declare = (id: string, body: ReturnType<typeof manifest>): MdbaseApplicationDeclaration =>
    ({ id, name: "Example", origin, environment: "lab", manifest: body, storage });

  it("registers fresh, then repeats onto the same application", async () => {
    const appId = `dev.example.fresh-${randomUUID().slice(0, 8)}`;
    const { registered: fresh } = await register(declare("example", manifest(appId)));
    expect(await rows(appId)).toEqual([expect.objectContaining({ id: fresh.id })]);
    expect(fresh.supersededDeclaredId).toBeUndefined();

    const { registered: repeat } = await register(declare(fresh.id, manifest(appId)));
    expect(repeat).toMatchObject({ id: fresh.id, manifestDigest: fresh.manifestDigest });
    expect(repeat.supersededDeclaredId).toBeUndefined();
    expect(await rows(appId)).toHaveLength(1);
  });

  it("accepts the new application for a changed manifest and keeps the declared storage", async () => {
    const appId = `dev.example.changed-${randomUUID().slice(0, 8)}`;
    const { registered: first } = await register(declare("example", manifest(appId)));
    const changed = manifest(appId, [`${origin}/callback`, `${origin}/return`]);

    const { registered, snapshot } = await register(declare(first.id, changed));
    expect(registered.id).not.toBe(first.id);
    expect(registered.supersededDeclaredId).toBe(first.id);
    expect((await rows(appId)).map(row => row.id).sort()).toEqual([first.id, registered.id].sort());
    const bound = rebindApplicationDeclaration(snapshot, registered);
    expect(bound.id).toBe(registered.id);
    expect(bound.storage).toEqual(storage);
  });

  it("refuses a reply whose canonical identity is not the manifest it sent", async () => {
    const appId = `dev.example.mismatch-${randomUUID().slice(0, 8)}`;
    const { registered: first } = await register(declare("example", manifest(appId)));
    const [original] = await rows(appId);
    const changed = manifest(appId, [`${origin}/callback`, `${origin}/elsewhere`]);

    await expect(register(declare(first.id, changed), cpFetch(application => {
      application.canonical_identity = original.canonical_identity;
    }))).rejects.toMatchObject({ reason: "application_registration_binding" });
  });
});
