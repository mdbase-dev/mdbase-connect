import { expect, it, vi } from "vitest";
import { MDBASE_TIMER_FIRED_CONTRACT } from "@mdbase-dev/connect-protocol";
import type { DatabaseConnection, DatabasePool } from "../../database-types.js";
import { canonicalSha256 } from "../../canonical-json.js";
import { installationApp, startInstallationPairing } from "../connectors/installation-pairing.js";
import { installationTimerDeclaration, readInstallationTimerDeclaration, type InstallationTimerBinding } from "./timers/installation-declaration.js";
import { backgroundTimerGrantResolver } from "./timers/grants.js";
import { backgroundGrantNotificationDeclaration } from "../../notifications.js";

const build = vi.hoisted(() => ({ local: true }));
vi.mock("../../local-build.js", () => ({ get LOCAL_REHEARSAL_BUILD() { return build.local; } }));
const origin = "http://127.0.0.1:8111", id = "10000000-0000-4000-8000-000000000001";
const application = {
  id, name: "Local Notes", family_identity: "bundle:local.notes", homepage: null,
  requirements: { access: "full_collection" as const, contracts: [], capabilities: { contract_version: 2 as const, required: ["background.schedule" as const] } },
  notifications: { criteria: [{ id: "reminder", event: MDBASE_TIMER_FIRED_CONTRACT, presentation: { title: "Reminder" } }] },
};
const cases = [
  ...(["app-runtime", "mobile"] as const).map(kind => ({ name: `local ${kind}`, local: true, server: "local", claimed: "local" as const, kind, origin, codec: true, admission: true })),
  ...["lab", "staging", "production", undefined].map(server => ({ name: `local claim on ${server}`, local: true, server, claimed: "local" as const, origin, codec: false, admission: false })),
  { name: "managed binary", local: false, server: "local", claimed: "local" as const, origin, codec: false, admission: false },
  ...["http://localhost:8111", "http://127.1:8111", "http://127.0.0.1", "http://127.0.0.1:0", origin + "/", origin + "?x", origin + "#x", "http://user@127.0.0.1:8111", "https://127.0.0.1:8111", "https://remote.example.test"].map(origin => ({ name: origin, local: true, server: "local", claimed: "local" as const, origin, codec: false, admission: false })),
  { name: "unregistered port", local: true, server: "local", claimed: "local" as const, origin: "http://127.0.0.1:8112", codec: true, admission: false },
  ...(["lab", "staging", "production"] as const).flatMap(server => [false, true].map(local => ({ name: `unchanged ${server}, local build ${local}`, local, server, claimed: server, origin: "https://notes.example.test", codec: true, admission: true }))),
];

it.each(cases)("binds pairing, frozen timers and background metadata to the server: $name", async entry => {
  build.local = entry.local;
  const kind = "kind" in entry ? entry.kind : "app-runtime";
  const binding: InstallationTimerBinding = { environment: entry.claimed, app_origin: entry.origin, kind };
  // Build a correctly digested snapshot even for refused contexts: refusal must
  // check server/origin scope, not accidentally rely on a bad digest.
  const body = { schema: "mdbase-installation-timers/1" as const, application_id: id, ...binding,
    operations: ["list_timers", "put_timer", "cancel_timer", "reconcile_timers"], notifications: application.notifications };
  const declaration = { ...body, digest: canonicalSha256({ domain: body.schema, declaration: body }).slice(7) };
  const registeredOrigin = entry.claimed === "local" ? origin : entry.origin;
  const registered = { ...application, installation_origins: { [entry.claimed]: { [kind]: [registeredOrigin] } } };
  const input = { request_id: id, pairing_secret: "test-pairing-secret", installation_id: id, device_id: id, kind };
  const pairing = { id, installation_id: id, device_id: id, app_id: id, app_origin: entry.origin, kind,
    timer_declaration: declaration, expires_at: new Date(Date.now() + 60_000), previous_pairing_id: null,
    scope_only: false, requested_create_collections: false, recovery_collection_id: null,
    file_access_collection_id: null, file_access_reason: null, requested_file_actions: null };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes("FROM applications") ? [registered]
    : sql.includes("SELECT p.*") ? [pairing]
    : sql.includes("SELECT principal_kind") ? [{ principal_kind: "installation" }]
    : sql.includes("FROM next_background_grants") ? [{ ...pairing, application_id: id, device_kind: kind, collection_id: id, revoked_at: "revoked" }]
    : [] }));
  const connection = { query, release: vi.fn() } as unknown as DatabaseConnection;
  const db = { query, connect: async () => connection } as unknown as DatabasePool;
  const construct = () => installationTimerDeclaration(application, binding, entry.server);
  const read = () => readInstallationTimerDeclaration(declaration, entry.server);
  const resolve = () => backgroundTimerGrantResolver(db, entry.server as InstallationTimerBinding["environment"]).resolve(connection, id);
  if (entry.codec) {
    expect(construct()).toEqual(declaration);
    expect(read()).toEqual(declaration);
    // A parsed declaration must NEVER turn revoked consent into authority.
    expect(await resolve()).toMatchObject({ usable: false, state: "e2e" });
    const metadataDb = { query: async () => ({ rows: [{ timer_declaration: declaration, revoked_at: null }] }) } as unknown as DatabasePool;
    expect(await backgroundGrantNotificationDeclaration(metadataDb, id, entry.server)).toEqual({ notifications: declaration.notifications, notification_criteria: declaration.notifications.criteria });
  } else {
    expect(construct).toThrow("Invalid registered installation timer declaration");
    expect(read).toThrow("Invalid registered installation timer declaration");
    await expect(resolve()).rejects.toThrow("Invalid registered installation timer declaration");
  }
  if (entry.admission) {
    const app = await installationApp(db, entry.server, id, entry.origin, kind);
    expect(app.timerDeclaration).toEqual(declaration);
    expect(await startInstallationPairing(db, input, app, origin, undefined, entry.server)).toMatchObject({ installation_device: true, app_origin: entry.origin });
    expect(() => readInstallationTimerDeclaration({ ...declaration, digest: "0".repeat(64) }, entry.server)).toThrow();
  } else {
    await expect(installationApp(db, entry.server, id, entry.origin, kind)).rejects.toMatchObject({ code: "installation_app_not_allowed", status: 403 });
  }
});
