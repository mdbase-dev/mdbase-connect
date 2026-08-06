import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MdbaseBrowserSelection,
  MdbaseConnect,
  MdbaseConnectError,
  isRetryableConnectError,
  parseMdbaseNativeNotificationData,
  parseMdbasePushPayload,
  showMdbasePushNotification
} from "./index.js";
import { connectError } from "./errors.js";
import {
  ConnectOutcomeError,
  connectSuccess,
  unwrapConnectOutcome
} from "./outcomes.js";
import { createPkce, MdbaseCollectionClient } from "./advanced.js";
import {
  MemoryApplicationIdentityStore,
  MemoryGrantKeyStore
} from "./crypto-entry.js";
import { MdbaseSession } from "./session.js";
import type {
  GrantEncryption,
  MdbaseAppManifest,
  TypePackProvision
} from "@mdbase-dev/connect-protocol";
import {
  AUTHORITY_PROOF_HEADERS,
  isConnectProblem,
  normalizeConnectProblem
} from "@mdbase-dev/connect-protocol";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TEST_COLLECTION_ID = "00000000-0000-0000-0000-000000000002";
const TEST_APPLICATION_ID = "00000000-0000-0000-0000-000000000001";
const TEST_MANIFEST_DIGEST = "0".repeat(64);

function registeredApplication(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
  id: TEST_APPLICATION_ID,
  family_identity: "bundle:dev.mdbase.test",
  manifest_digest: TEST_MANIFEST_DIGEST,
    name: "Tasks",
    homepage: "https://tasks.example/",
    requirements: { contracts: [] },
    ...overrides
  };
}
const WORK_ITEM_CONTRACT = {
  contract_type: "record",
  id: "example.work-item",
  version: "1.0.0",
  digest: `sha256:${"0".repeat(64)}`,
  schema: { type: "object" },
  implementations: [{
    type_name: "task",
    type_version: 1,
    digest: `sha256:${"1".repeat(64)}`,
    fields: { title: "title" }
  }]
};

describe("PKCE", () => {
  it("creates an OAuth S256 verifier and challenge", async () => {
    const pair = await createPkce();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("provider-neutral collection client", () => {
  it("maps collection descriptors without rewriting canonical configuration data", async () => {
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        return {
          protocol_version: 1,
          collection_id: TEST_COLLECTION_ID,
          display_name: "Notes",
          spec_version: "0.3.0",
          operations: ["describe", "query"],
          change_cursor: 7,
          types: [],
          contracts: [{
            contract_type: "record",
            id: "example.note",
            version: "1.0.0",
            digest: `sha256:${"1".repeat(64)}`,
            schema: { type: "object" },
            binding_schema: { type: "object" },
            implementations: [{
              type_name: "note",
              type_version: 1,
              type_path: "_types/note.md",
              digest: `sha256:${"2".repeat(64)}`,
              fields: { title: "title" }
            }]
          }],
          configuration: { spec_version: "0.3.0", x_custom: { snake_key: true } }
        } as Result;
      }
    });

    const description = unwrapConnectOutcome(await client.describe());

    expect(description).toMatchObject({
      protocolVersion: 1,
      collectionId: TEST_COLLECTION_ID,
      displayName: "Notes",
      specVersion: "0.3.0",
      changeCursor: 7,
      contracts: [{
        contractType: "record",
        bindingSchema: { type: "object" },
        implementations: [{ typeName: "note", typeVersion: 1, typePath: "_types/note.md" }]
      }],
      configuration: { spec_version: "0.3.0", x_custom: { snake_key: true } }
    });
  });

  it("creates body-only records without manufacturing an empty frontmatter object", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        return {
          valid: true,
          result: {
            path: "plain.md",
            revision: "sha256:plain",
            types: [],
            frontmatter: { custom_snake_key: "preserved" },
            effective_frontmatter: { custom_snake_key: "preserved", inherited: true },
            body: "# Plain",
            file: { name: "plain.md", folder: "", size: 7, mtime: "2026-07-27T00:00:00Z" },
            contract: {
              id: "example.note",
              version: "1.0.0",
              digest: `sha256:${"5".repeat(64)}`,
              type: "note",
              implementation_digest: `sha256:${"6".repeat(64)}`
            }
          },
          diagnostics: []
        } as Result;
      }
    });

    const created = await client.create({ path: "plain.md", body: "# Plain" });

    expect(created).toMatchObject({
      ok: true,
      value: {
        frontmatter: { custom_snake_key: "preserved" },
        effectiveFrontmatter: { custom_snake_key: "preserved", inherited: true },
        contract: { implementationDigest: `sha256:${"6".repeat(64)}` }
      },
      diagnostics: []
    });
    expect(calls).toEqual([{
      operation: "create",
      input: { path: "plain.md", body: "# Plain" }
    }]);
  });

  it("sends the canonical v0.3 patch shape through an injected transport", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        return { valid: true, result: { path: "task.md" }, diagnostics: [] } as Result;
      }
    });
    await client.update({ path: "task.md", patch: { status: "done" }, ifRevision: "revision:1" });
    expect(calls).toEqual([{
      operation: "update",
      input: { path: "task.md", patch: { status: "done" }, if_revision: "revision:1" }
    }]);
  });

  it("exposes revision-safe type document operations", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        const receipt = {
          id: "example.tasks",
          version: "1.0.0",
          digest: `sha256:${"2".repeat(64)}`,
          installed_by: "dev.mdbase.tests",
          resources: []
        };
        return {
          valid: true,
          result: operation === "assess_type_pack" || operation === "apply_type_pack"
            ? {
                status: "install",
                applicable: true,
                assessment_digest: `sha256:${"3".repeat(64)}`,
                desired: receipt,
                resources: [],
                lock: { target: "mdbase.lock.yaml", action: "create", digest: `sha256:${"4".repeat(64)}` },
                contract_setups: { choices: [], resources: [] },
                ...(operation === "apply_type_pack" ? { receipt, cleanup_deferred: false } : {})
              }
            : {},
          diagnostics: []
        } as Result;
      }
    });
    await client.readType({ name: "task" });
    await client.createType({ document: "---\nkind: mdbase.type\n---\n" });
    await client.updateType({
      path: "_types/task.md",
      document: "---\nkind: mdbase.type\n---\n",
      ifRevision: "sha256:one"
    });
    const provision = {
      manifest: {
        kind: "mdbase.type-pack",
        id: "example.tasks",
        version: "1.0.0",
        resources: [{
          kind: "type",
          mode: "seed",
          source: "types/task.md",
          target: "_types/task.md",
          digest: `sha256:${"1".repeat(64)}`
        }]
      },
      resources: [{
        source: "types/task.md",
        document: "---\nkind: mdbase.type\n---\n"
      }],
      provides: []
    } satisfies TypePackProvision;
    const assessment = unwrapConnectOutcome(await client.assessTypePack({
      provision,
      installedBy: "dev.mdbase.tests"
    }));
    await client.applyTypePack({
      provision,
      installedBy: "dev.mdbase.tests",
      expectedAssessmentDigest: assessment.assessmentDigest
    });
    expect(calls.map(({ operation }) => operation)).toEqual([
      "read_type",
      "create_type",
      "update_type",
      "assess_type_pack",
      "apply_type_pack"
    ]);
  });

  it("exposes grant-scoped timer reconciliation without raw authority keys", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        return {
          namespace: "task-reminders",
          timers: [],
          cancelled_ids: []
        } as Result;
      }
    });
    await client.reconcileTimers({
      namespace: "task-reminders",
      criterionId: "task.reminder",
      timers: [{
        id: "task:reminder",
        fireAt: "2026-07-25T10:00:00Z",
        data: { kind: "task" }
      }]
    });
    expect(calls).toEqual([{
      operation: "reconcile_timers",
      input: {
        namespace: "task-reminders",
        criterion_id: "task.reminder",
        timers: [{
          id: "task:reminder",
          fire_at: "2026-07-25T10:00:00Z",
          data: { kind: "task" }
        }]
      }
    }]);
  });

  it("provides typed mutation preflights without changing normal mutation inputs", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        return { valid: true, result: {}, diagnostics: [] } as Result;
      }
    });

    await client.preflightRename({ from: "old.md", to: "new.md", updateRefs: true, ifRevision: "revision:1" });
    await client.preflightDelete({ path: "old.md", ifRevision: "revision:1" });
    await client.rename({ from: "old.md", to: "new.md", updateRefs: false, ifRevision: "revision:1" });

    expect(calls).toEqual([
      {
        operation: "rename",
        input: { from: "old.md", to: "new.md", update_refs: true, if_revision: "revision:1", dry_run: true }
      },
      {
        operation: "delete",
        input: { path: "old.md", if_revision: "revision:1", check_backlinks: true, dry_run: true }
      },
      {
        operation: "rename",
        input: { from: "old.md", to: "new.md", update_refs: false, if_revision: "revision:1" }
      }
    ]);
  });

  it("exposes provider-neutral saved-view execution and source editing", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        const result = operation === "list_views"
          ? { views: [], meta: { total_count: 0 } }
          : operation === "execute_view"
            ? { results: [], meta: { total_count: 0, has_more: false, view: { path: "Worklog/Views/tasks.base", id: "kanban-board" } } }
            : operation === "delete_view_source"
              ? { path: "Worklog/Views/tasks.base", deleted: true }
              : { path: "Worklog/Views/tasks.base", format: "base", revision: "sha256:one", document: "views: []\n" };
        return { valid: true, result, diagnostics: [] } as Result;
      }
    });
    await client.listViews();
    await client.executeView({
      path: "Worklog/Views/tasks.base",
      view: "kanban-board",
      timezone: "Australia/Melbourne",
      limit: 50
    });
    await client.readViewSource({ path: "Worklog/Views/tasks.base" });
    await client.createViewSource({
      path: "Worklog/Views/new.base",
      document: "views: []\n"
    });
    await client.updateViewSource({
      path: "Worklog/Views/tasks.base",
      ifRevision: "sha256:one",
      document: "views: []\n"
    });
    await client.deleteViewSource({
      path: "Worklog/Views/tasks.base",
      ifRevision: "sha256:two"
    });
    expect(calls).toEqual([
      { operation: "list_views", input: {} },
      {
        operation: "execute_view",
        input: {
          path: "Worklog/Views/tasks.base",
          view: "kanban-board",
          timezone: "Australia/Melbourne",
          limit: 50
        }
      },
      {
        operation: "read_view_source",
        input: { path: "Worklog/Views/tasks.base" }
      },
      {
        operation: "create_view_source",
        input: {
          path: "Worklog/Views/new.base",
          document: "views: []\n"
        }
      },
      {
        operation: "update_view_source",
        input: {
          path: "Worklog/Views/tasks.base",
          if_revision: "sha256:one",
          document: "views: []\n"
        }
      },
      {
        operation: "delete_view_source",
        input: {
          path: "Worklog/Views/tasks.base",
          if_revision: "sha256:two"
        }
      }
    ]);
  });

  it("pages a query with one stable snapshot and reports exact progress", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const records = ["one.md", "two.md", "three.md"].map((path) => ({ path, frontmatter: {}, types: [] }));
    const client = new MdbaseCollectionClient({
      async operation<Result>(_operation: string, input: unknown) {
        const query = input as { offset: number; limit: number; snapshot?: string };
        calls.push(query);
        const results = records.slice(query.offset, query.offset + query.limit);
        return {
          valid: true,
          diagnostics: [],
          result: {
            results,
            meta: {
              total_count: records.length,
              has_more: query.offset + results.length < records.length,
              snapshot: "stable-query"
            }
          }
        } as Result;
      }
    });
    const progress: Array<{ loaded: number; complete: boolean }> = [];
    const loaded: string[] = [];

    for await (const outcome of client.queryPages(
      { includeBody: false, orderBy: [{ field: "file.mtime", direction: "desc" }], timezone: "Australia/Melbourne" },
      { firstPageSize: 1, pageSize: 2, onProgress: ({ loaded, complete }) => progress.push({ loaded, complete }) }
    )) {
      expect(outcome.ok).toBe(true);
      if (outcome.ok) loaded.push(...outcome.value.results.map((record) => record.path));
    }

    expect(loaded).toEqual(["one.md", "two.md", "three.md"]);
    expect(progress).toEqual([{ loaded: 1, complete: false }, { loaded: 3, complete: true }]);
    expect(calls).toEqual([
      { include_body: false, order_by: [{ field: "file.mtime", direction: "desc" }], timezone: "Australia/Melbourne", offset: 0, limit: 1 },
      { include_body: false, order_by: [{ field: "file.mtime", direction: "desc" }], timezone: "Australia/Melbourne", offset: 1, limit: 2, snapshot: "stable-query" }
    ]);
  });

  it("maps the complete typed query contract without leaking wire names", async () => {
    let wireInput: unknown;
    const client = new MdbaseCollectionClient({
      async operation<Result>(_operation: string, input: unknown) {
        wireInput = input;
        return {
          valid: true,
          diagnostics: [],
          result: {
            results: [{
              path: "one.md",
              frontmatter: { user_snake_key: true },
              effective_frontmatter: { user_snake_key: true, inherited: "yes" },
              types: ["note"],
              file: {},
              contract: {
                id: "example.note",
                version: "1.0.0",
                digest: `sha256:${"7".repeat(64)}`,
                type: "note",
                implementation_digest: `sha256:${"8".repeat(64)}`
              }
            }],
            meta: { total_count: 1, has_more: false }
          }
        } as Result;
      }
    });

    const result = unwrapConnectOutcome(await client.query({
      types: ["note"],
      projections: { age: { expression: "age_days(file.mtime)" } },
      where: "status == 'open'",
      select: ["file.path", { name: "age", expression: "age", label: "Age" }],
      orderBy: [{ field: "file.mtime", direction: "desc" }],
      groupBy: [{ field: "status" }],
      summaryFunctions: { count_open: { expression: "count()" } },
      summaries: [{ field: "status", function: "count_open" }],
      includeBody: false,
      frontmatterMode: "both"
    }));

    expect(wireInput).toEqual({
      types: ["note"],
      projections: { age: { expr: "age_days(file.mtime)" } },
      where: "status == 'open'",
      select: ["file.path", { name: "age", expr: "age", label: "Age" }],
      order_by: [{ field: "file.mtime", direction: "desc" }],
      group_by: [{ field: "status" }],
      summary_functions: { count_open: { expr: "count()" } },
      summaries: [{ field: "status", function: "count_open" }],
      include_body: false,
      frontmatter_mode: "both"
    });
    expect(result).toMatchObject({
      results: [{
        frontmatter: { user_snake_key: true },
        effectiveFrontmatter: { user_snake_key: true, inherited: "yes" },
        contract: { implementationDigest: `sha256:${"8".repeat(64)}` }
      }],
      meta: { totalCount: 1, hasMore: false }
    });
  });

  it("uses one total queryAll deadline while queryPages keeps an explicit per-page budget", async () => {
    vi.useFakeTimers();
    const requestOptions: Array<{ signal?: AbortSignal; timeoutMs?: number | null }> = [];
    let page = 0;
    const client = new MdbaseCollectionClient({
      async operation<Result>(
        _operation: string,
        _input: unknown,
        options?: { signal?: AbortSignal; timeoutMs?: number | null }
      ) {
        requestOptions.push(options ?? {});
        page += 1;
        if (page === 1) {
          return {
            valid: true,
            diagnostics: [],
            result: {
              results: [{ path: "one.md", frontmatter: {}, types: [] }],
              meta: { total_count: 2, has_more: true, snapshot: "total-budget" }
            }
          } as Result;
        }
        return new Promise<Result>((_resolve, reject) => {
          const abort = () => reject(options?.signal?.reason);
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
    });

    const outcome = client.queryAll({}, {
      firstPageSize: 1,
      pageSize: 1,
      timeoutMs: 50
    });
    await vi.advanceTimersByTimeAsync(50);

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      problem: { code: "timeout", operation_outcome: "not_sent" }
    });
    expect(requestOptions).toHaveLength(2);
    expect(requestOptions[0]?.signal).toBe(requestOptions[1]?.signal);
    expect(requestOptions.map(({ timeoutMs }) => timeoutMs)).toEqual([null, null]);
  });

  it("rejects a changed snapshot instead of mixing query generations", async () => {
    let call = 0;
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        call += 1;
        return {
          valid: true,
          diagnostics: [],
          result: {
            results: [{ path: `${call}.md`, frontmatter: {}, types: [] }],
            meta: { total_count: 2, has_more: call === 1, snapshot: `snapshot-${call}` }
          }
        } as Result;
      }
    });
    const iterator = client.queryPages({}, { firstPageSize: 1, pageSize: 1 });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { ok: true, value: { snapshot: "snapshot-1" } }
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        ok: false,
        problem: { code: "query_snapshot_changed", recovery: "refresh" }
      }
    });
  });

  it("surfaces cursor resets from any transport", async () => {
    const statuses: string[] = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        return { events: [], cursor: 10, has_more: false, reset: true } as Result;
      }
    });
    const iterator = client.watch({
      cursor: 1,
      pollIntervalMs: 100,
      onStatus: (status) => statuses.push(status.state)
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        ok: false,
        problem: { code: "change_cursor_reset", recovery: "refresh" }
      }
    });
    expect(statuses).toEqual(["connecting", "reset_required"]);
  });

  it("retries transient watch failures without losing the last cursor", async () => {
    const calls: unknown[] = [];
    let call = 0;
    const client = new MdbaseCollectionClient({
      async operation<Result>(_operation: string, input: unknown) {
        calls.push(input);
        call += 1;
        if (call === 1) return { events: [], cursor: 5, has_more: false } as Result;
        if (call === 2) throw connectError("connector_offline", "Offline.", { status: 503 });
        return {
          events: [{ cursor: 6, type: "mdbase.record.modified", occurred_at: "2026-07-23T00:00:00Z", payload: { path: "notes/one.md" } }],
          cursor: 6,
          has_more: false
        } as Result;
      }
    });
    const statuses: Array<{ state: string; cursor?: number; recovered?: boolean }> = [];
    const iterator = client.watch({
      pollIntervalMs: 100,
      retry: { initialDelayMs: 0, maxDelayMs: 0 },
      onStatus: (status) => statuses.push(status)
    });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        ok: true,
        value: { cursor: 6, type: "mdbase.record.modified" }
      },
      done: false
    });
    await iterator.return(undefined);

    expect(calls).toEqual([
      {},
      { after: 5, limit: 200 },
      { after: 5, limit: 200 }
    ]);
    expect(statuses).toMatchObject([
      { state: "connecting" },
      { state: "reconnecting", cursor: 5 },
      { state: "connected", cursor: 5, recovered: true }
    ]);
  });

  it("can opt out of automatic watch retries", async () => {
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        throw connectError("connector_offline", "Offline.", { status: 503 });
      }
    });
    const statuses: string[] = [];
    const iterator = client.watch({ retry: false, onStatus: (status) => statuses.push(status.state) });

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { ok: false, problem: { code: "connector_offline" } }
    });
    expect(statuses).toEqual(["connecting"]);
  });

  it("requires browser-dependent defaults only when callers omit them", () => {
    expect(() => new MdbaseConnect({ serverUrl: "https://connect.example" }))
      .toThrow(MdbaseConnectError);
    expect(() => new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage()
    })).not.toThrow();
  });

  it("registers a bundled application declaration inline", async () => {
    const manifest: MdbaseAppManifest = {
      manifest_version: 1,
      id: "dev.mdbase.tasks",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["https://tasks.example/auth/mdbase/callback"]
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      application: {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Tasks",
        homepage: "https://tasks.example/"
      }
    }));
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest,
      redirectUri: manifest.redirect_uris[0],
      storage: new MemoryStorage()
    });

    await expect(connect.register()).resolves.toMatchObject({
      ok: true,
      value: { name: "Tasks" }
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://connect.example/v1/apps/register"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      manifest
    });
  });

  it("loads a bundled declaration locally before registering it", async () => {
    const manifestUrl = "capacitor://localhost/.well-known/mdbase-app.json";
    const manifest = {
      manifest_version: 1,
      id: "dev.mdbase.tasks",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: ["dev.mdbase.tasks://auth/mdbase/callback"]
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(manifest))
      .mockResolvedValueOnce(jsonResponse({
        application: {
          id: "00000000-0000-0000-0000-000000000001",
          name: "Tasks",
          homepage: "https://tasks.example/"
        }
      }));
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: manifestUrl,
      redirectUri: manifest.redirect_uris[0],
      storage: new MemoryStorage()
    });

    await connect.register();
    expect(fetchMock.mock.calls.map(([request]) => String(request))).toEqual([
      manifestUrl,
      "https://connect.example/v1/apps/register"
    ]);
  });

  it("keeps opaque portable credentials in memory by default", () => {
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: portableManifest()
    });

    expect(connect.environment()).toEqual({
      distribution: "portable",
      applicationOrigin: "null",
      credentialStorage: "memory"
    });
  });

  it("completes key-bound device authorization without redirecting the portable page", async () => {
    vi.useFakeTimers();
    const portableCollectionId = "01944444-4444-7444-8444-444444444444";
    const storage = new MemoryStorage();
    const keyStore = new MemoryGrantKeyStore();
    const opened = vi.fn();
    const shown: string[] = [];
    const connectorKeys = new MemoryGrantKeyStore();
    const connectorIdentity = await connectorKeys.create("connector");
    const connectorId = "01933333-3333-7333-8333-333333333333";
    let applicationAgreementPublicKey = "";
    let polls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/v1/apps/register")) {
        return jsonResponse({
          application: registeredApplication({
            name: "Portable notes",
            distribution: "portable",
            project_url: "https://apps.example/portable"
          })
        });
      }
      if (url.endsWith("/oauth/device_authorization")) {
        const form = new URLSearchParams(String(init?.body));
        const proof = JSON.parse(form.get("application_authorization")!);
        applicationAgreementPublicKey = proof.binding.grant_agreement_public_key;
        expect(form.get("operations")).toBe("describe,query");
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://connect.example/device",
          verification_uri_complete: "https://connect.example/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 1
        });
      }
      if (url.endsWith("/oauth/token")) {
        polls += 1;
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
        expect(form.get("device_code")).toBe("device-secret");
        if (polls === 1) {
          return jsonResponse({
            error: "authorization_pending",
            error_description: "Pending."
          }, 400);
        }
        return jsonResponse({
          access_token: "mdb_portable",
          refresh_token: "ref_portable",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 86_400,
          collection_id: portableCollectionId,
          collection_name: "Portable notes",
          operations: ["describe", "query"],
          scope: { contracts: [], access: "full_collection" },
          grant_id: "00000000-0000-0000-0000-000000000003",
          application_origin: "null",
          encryption: {
            protocol_version: 1,
            suite: "P256-HKDF-SHA256-AES256GCM",
            key_id: "portable-key",
            scope_epoch: 1,
            connector_id: connectorId,
            collection_id: portableCollectionId,
            application_agreement_public_key: applicationAgreementPublicKey,
            connector_agreement_public_key: connectorIdentity.agreementPublicKey
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: portableManifest(),
      storage,
      keyStore
    });

    const authorization = connect.authorize({
      operations: ["describe", "query"],
      onDeviceCode: ({ userCode }) => shown.push(userCode),
      openVerification: opened
    });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect(shown).toEqual(["ABCD-EFGH"]);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(authorization).resolves.toMatchObject({
      ok: true,
      value: { connection: { collectionId: portableCollectionId } }
    });
    expect(connect.connections()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("accepts a scoped hosted capability from the same portable device flow", async () => {
    vi.useFakeTimers();
    const keyStore = new MemoryGrantKeyStore();
    const deleteKey = vi.spyOn(keyStore, "delete");
    const opened = vi.fn();
    let applicationSigningPublicKey = "";
    let providerHeaders: Record<string, string> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/v1/apps/register")) {
        return jsonResponse({
          application: registeredApplication({
            name: "Portable hosted notes",
            distribution: "portable",
            requirements: {
              contracts: [],
              access: "full_collection",
              collection_kind: "hosted",
              files: {
                actions: ["list", "read"],
                scope: { kind: "collection" }
              }
            }
          })
        });
      }
      if (url.endsWith("/oauth/device_authorization")) {
        applicationSigningPublicKey = JSON.parse(
          new URLSearchParams(String(init?.body)).get("application_authorization")!
        ).binding.grant_signing_public_key;
        return jsonResponse({
          device_code: "hosted-device-secret",
          user_code: "HOST-CODE",
          verification_uri: "https://connect.example/device",
          verification_uri_complete: "https://connect.example/device?user_code=HOST-CODE",
          expires_in: 600,
          interval: 1
        });
      }
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          access_token: "mdb_portable_hosted",
          refresh_token: "ref_portable_hosted",
          token_type: "Bearer",
          expires_in: 900,
          refresh_expires_in: 86_400,
          collection_id: TEST_COLLECTION_ID,
          collection_name: "Portable hosted notes",
          operations: ["describe", "query"],
          scope: { contracts: [], access: "full_collection" },
          grant_id: "00000000-0000-0000-0000-000000000003",
          application_origin: "null",
          encryption: null,
          file_capability: {
            kind: "files",
            protocol_version: 1,
            actions: ["list", "read"],
            scope: { kind: "collection" }
          },
          authority: {
            operations_url: "https://provider.example/v1/authorities/00000000-0000-0000-0000-000000000002/operations",
            sync_url: "https://provider.example/v1/authorities/00000000-0000-0000-0000-000000000002/sync",
            files_url: "https://provider.example/v1/authorities/00000000-0000-0000-0000-000000000002/files",
            replica_id: "00000000-0000-0000-0000-000000000005",
            access_token: "hsa_portable_hosted",
            proof_public_key: applicationSigningPublicKey
          }
        });
      }
      if (url.includes("/operations/query")) {
        providerHeaders = init?.headers as Record<string, string>;
        const operation = JSON.parse(String(init?.body));
        return jsonResponse({
          protocol_version: 2,
          request_id: operation.request_id,
          ok: true,
          result: { valid: true, result: { results: [] }, diagnostics: [] }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: {
        ...portableManifest(),
        requirements: {
          contracts: [],
          access: "full_collection",
          collection_kind: "hosted",
          files: {
            actions: ["list", "read"],
            scope: { kind: "collection" }
          }
        }
      },
      keyStore
    });

    const authorization = connect.authorize({
      operations: ["describe", "query"],
      openVerification: opened
    });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);

    const result = unwrapConnectOutcome(await authorization);
    expect(result.connection).toMatchObject({
      collectionId: TEST_COLLECTION_ID,
      route: "remote",
      fileCapability: {
        kind: "files",
        protocol_version: 1,
        actions: ["list", "read"],
        scope: { kind: "collection" }
      }
    });
    expect(deleteKey).not.toHaveBeenCalled();
    expect(connect.connections()).toHaveLength(1);
    expect((await result.connection.query()).ok).toBe(true);
    expect(providerHeaders?.[AUTHORITY_PROOF_HEADERS.version]).toBe("1");
    expect(providerHeaders?.[AUTHORITY_PROOF_HEADERS.signature]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns the verification details when a portable approval popup is blocked", async () => {
    const keyStore = new MemoryGrantKeyStore();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        application: registeredApplication({
          name: "Portable notes",
          distribution: "portable"
        })
      }))
      .mockResolvedValueOnce(jsonResponse({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://connect.example/device",
        verification_uri_complete: "https://connect.example/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5
      }));
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: portableManifest(),
      storage: new MemoryStorage(),
      keyStore,
      navigate: vi.fn()
    });

    await expect(connect.authorize()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "approval_window_blocked",
        details: {
          user_code: "ABCD-EFGH",
          verification_uri: "https://connect.example/device"
        }
      }
    });
  });

  it("rejects a portable token that is not bound to encrypted relay protocol v1", async () => {
    vi.useFakeTimers();
    let applicationAgreementPublicKey = "";
    const opened = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/v1/apps/register")) {
        return jsonResponse({
          application: registeredApplication({
            name: "Portable notes",
            distribution: "portable"
          })
        });
      }
      if (url.endsWith("/oauth/device_authorization")) {
        applicationAgreementPublicKey = JSON.parse(
          new URLSearchParams(String(init?.body)).get("application_authorization")!
        ).binding.grant_agreement_public_key;
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://connect.example/device",
          verification_uri_complete: "https://connect.example/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 1
        });
      }
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          access_token: "mdb_portable",
          refresh_token: "ref_portable",
          token_type: "Bearer",
          expires_in: 900,
          collection_id: TEST_COLLECTION_ID,
          collection_name: "Portable notes",
          operations: ["describe", "query"],
          scope: { contracts: [], access: "full_collection" },
          grant_id: "00000000-0000-0000-0000-000000000003",
          application_origin: "null",
          encryption: {
            protocol_version: 2,
            suite: "P256-HKDF-SHA256-AES256GCM",
            key_id: "portable-key",
            scope_epoch: 1,
            connector_id: "00000000-0000-0000-0000-000000000004",
            collection_id: TEST_COLLECTION_ID,
            application_agreement_public_key: applicationAgreementPublicKey,
            connector_agreement_public_key: "BFmPz3M5jSOhCzJfU3NTx_JYnNsIs_L-9fY0m7yRLJKPiGNmzF8NYdylXsClXhuDl1nlueHBMWtZGLnEorD_g18"
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: portableManifest(),
      storage: new MemoryStorage(),
      keyStore: new MemoryGrantKeyStore()
    });

    const authorization = expect(
      connect.authorize({ openVerification: opened })
    ).resolves.toMatchObject({
      ok: false,
      problem: { code: "encryption_required" }
    });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);

    await authorization;
    expect(connect.connections()).toHaveLength(0);
  });

  it("rejects a remote authority capability served over non-loopback HTTP", async () => {
    vi.useFakeTimers();
    let applicationSigningPublicKey = "";
    const opened = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/v1/apps/register")) {
        return jsonResponse({
          application: registeredApplication({
            name: "Portable notes",
            distribution: "portable"
          })
        });
      }
      if (url.endsWith("/oauth/device_authorization")) {
        applicationSigningPublicKey = JSON.parse(
          new URLSearchParams(String(init?.body)).get("application_authorization")!
        ).binding.grant_signing_public_key;
        return jsonResponse({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://connect.example/device",
          verification_uri_complete: "https://connect.example/device?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 1
        });
      }
      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          access_token: "mdb_portable",
          refresh_token: "ref_portable",
          token_type: "Bearer",
          expires_in: 900,
          collection_id: TEST_COLLECTION_ID,
          collection_name: "Portable notes",
          operations: ["describe", "query"],
          scope: { contracts: [], access: "full_collection" },
          grant_id: "00000000-0000-0000-0000-000000000003",
          application_origin: "null",
          encryption: null,
          authority: {
            operations_url: `http://provider.example/v1/authorities/${TEST_COLLECTION_ID}/operations`,
            sync_url: `http://provider.example/v1/authorities/${TEST_COLLECTION_ID}/sync`,
            files_url: `http://provider.example/v1/authorities/${TEST_COLLECTION_ID}/files`,
            replica_id: "00000000-0000-0000-0000-000000000005",
            access_token: "authority_access",
            proof_public_key: applicationSigningPublicKey
          }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: portableManifest(),
      storage: new MemoryStorage(),
      keyStore: new MemoryGrantKeyStore()
    });

    const authorization = expect(
      connect.authorize({ openVerification: opened })
    ).resolves.toMatchObject({
      ok: false,
      problem: { code: "invalid_token_response" }
    });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);

    await authorization;
    expect(connect.connections()).toHaveLength(0);
  });
});

describe("actionable SDK errors", () => {
  it("rejects malformed problem metadata and required details at runtime", () => {
    expect(isConnectProblem({
      problem_version: 1,
      code: "collection_version_unsupported",
      category: "compatibility",
      recovery: "upgrade_collection",
      message: "Upgrade required."
    })).toBe(false);
    expect(isConnectProblem({
      problem_version: 1,
      code: "connector_offline",
      category: "availability",
      recovery: "retry",
      message: "Connector offline.",
      operation_outcome: "maybe"
    })).toBe(false);
    expect(normalizeConnectProblem(
      "collection_version_unsupported",
      "Upgrade required."
    )).toMatchObject({ code: "unknown", server_code: "collection_version_unsupported" });
    expect(normalizeConnectProblem(
      "collection_version_unsupported",
      "Upgrade required.",
      { details: { current_version: "0.2.0", required_version: "0.3.0" } }
    )).toMatchObject({ code: "collection_version_unsupported" });
  });

  it("normalizes registration network failures at the I/O boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network unavailable"));
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: portableManifest(),
      storage: new MemoryStorage(),
      keyStore: new MemoryGrantKeyStore()
    });

    await expect(connect.register()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "temporarily_unavailable",
        category: "availability",
        recovery: "retry"
      }
    });
  });

  it("classifies retry, authorization, refresh, and uncertain-outcome recovery", () => {
    const offline = connectError("connector_offline", "Connector offline.", { status: 503 });
    expect(offline).toMatchObject({
      name: "MdbaseConnectError",
      status: 503,
      retryable: true,
      requiresAuthorization: false,
      outcomeUnknown: false,
      recovery: "retry"
    });
    expect(isRetryableConnectError(offline)).toBe(true);
    expect(isRetryableConnectError(new TypeError("network unavailable"))).toBe(false);

    expect(connectError("authorization_expired", "Reconnect.")).toMatchObject({
      retryable: false,
      requiresAuthorization: true,
      recovery: "reauthorize"
    });
    expect(connectError("change_cursor_reset", "Refresh.")).toMatchObject({
      retryable: false,
      recovery: "refresh"
    });
    expect(connectError("operation_outcome_unknown", "Check the write.", {
      operationOutcome: "unknown",
      details: { request_id: "request-unknown" }
    })).toMatchObject({
      retryable: false,
      outcomeUnknown: true,
      recovery: "resolve_outcome"
    });
  });

  it("normalizes collection envelopes and offers an explicit throwing adapter", async () => {
    const envelope = {
      valid: false,
      result: { path: "notes/one.md", inspected: true },
      diagnostics: [
        { severity: "warning" as const, code: "deprecated", message: "A legacy field is present." },
        { severity: "error" as const, code: "missing_required", message: "Title is required.", field: "title" }
      ]
    };
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        return envelope as Result;
      }
    });
    const outcome = await client.read({ path: "notes/one.md" });

    expect(outcome).toMatchObject({
      ok: false,
      problem: {
        code: "operation_invalid",
        message: "Title is required.",
        operation_outcome: "rejected",
        details: {
          diagnostics: envelope.diagnostics,
          partial_result: envelope.result
        }
      }
    });
    expect(() => unwrapConnectOutcome(outcome)).toThrow(ConnectOutcomeError);
    try {
      unwrapConnectOutcome(outcome);
    } catch (error) {
      expect(error).toMatchObject({
        problem: { code: "operation_invalid", details: { partial_result: envelope.result } }
      });
    }
  });

  it("distinguishes legacy, invalid configuration, and invalid type-registry setup", async () => {
    const envelopes = [
      {
        valid: false,
        result: {},
        diagnostics: [{
          severity: "error" as const,
          code: "migration_required",
          message: "This write requires migrating the v0.2 collection.",
          details: { current_version: "0.2.0", required_version: "0.3.0" }
        }]
      },
      {
        valid: false,
        result: {},
        diagnostics: [{
          severity: "error" as const,
          code: "invalid_config",
          message: "spec_version must be a string.",
          path: "mdbase.yaml"
        }]
      },
      {
        valid: false,
        result: {},
        diagnostics: [{
          severity: "error" as const,
          code: "invalid_type_definition",
          message: "Type frontmatter is invalid.",
          path: "_types/task.md"
        }]
      }
    ];
    const client = new MdbaseCollectionClient({
      async operation<Result>() {
        return envelopes.shift() as Result;
      }
    });

    await expect(client.create({ path: "new.md", body: "" })).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "collection_version_unsupported",
        category: "compatibility",
        recovery: "upgrade_collection",
        operation_outcome: "rejected",
        details: { current_version: "0.2.0", required_version: "0.3.0" }
      }
    });
    await expect(client.validate()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "collection_configuration_invalid",
        recovery: "repair_collection"
      }
    });
    await expect(client.read({ path: "one.md" })).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "collection_type_registry_invalid",
        recovery: "repair_collection"
      }
    });
  });

  it("normalizes server failures into transport-independent problems", async () => {
    const fixture = await encryptedConnection();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "connector_offline",
        message: "The connector is asleep.",
        details: { connector_name: "Studio" }
      }
    }), { status: 503, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "connector_offline",
        category: "availability",
        recovery: "retry",
        details: { connector_name: "Studio" }
      }
    });
  });

  it("accepts canonical wire problems and preserves unknown future codes", async () => {
    const serverUrl = "https://connect.example";
    const manifest = "https://tasks.example/manifest.json";
    const storage = new MemoryStorage();
    storage.setItem(storedTokenKey(serverUrl, manifest, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "plain-relay-token",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: TEST_COLLECTION_ID,
      collectionName: "Tasks",
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000
    }));
    const manager = new MdbaseConnect({
      serverUrl,
      manifest,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled",
      directAccess: "disabled"
    });
    const connection = manager.connection(TEST_COLLECTION_ID)!;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockImplementationOnce(async (_request, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse({
        protocol_version: 2,
        request_id: request.request_id,
        ok: false,
        problem: {
          problem_version: 1,
          code: "access_paused",
          category: "availability",
          recovery: "resume_connector_access",
          message: "Remote access is paused.",
          operation_outcome: "rejected"
        }
      });
    });
    fetchMock.mockImplementationOnce(async (_request, init) => {
      const request = JSON.parse(String(init?.body));
      return jsonResponse({
        protocol_version: 2,
        request_id: request.request_id,
        ok: false,
        problem: {
          problem_version: 1,
          code: "unknown",
          server_code: "future_connector_state",
          category: "unknown",
          recovery: "none",
          message: "A future connector state occurred."
        }
      });
    });

    await expect(connection.query()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "access_paused",
        recovery: "resume_connector_access",
        operation_outcome: "rejected"
      }
    });
    await expect(connection.query()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "unknown",
        server_code: "future_connector_state",
        recovery: "none"
      }
    });
  });
});

describe("mobile notifications", () => {
  const serverUrl = "https://connect.example";
  const manifest: MdbaseAppManifest = {
    manifest_version: 1,
    id: "dev.mdbase.tasks",
    name: "Worklog",
    homepage: "https://tasks.example/",
    redirect_uris: [
      "https://tasks.example/callback",
      "dev.mdbase.tasks://auth/mdbase/callback"
    ]
  };
  const manifestSource = `bundle:${manifest.id}`;
  const tokenKey = storedTokenKey(serverUrl, manifestSource, TEST_COLLECTION_ID);

  it("registers the selected criteria atomically for one browser installation", async () => {
    const storage = new MemoryStorage();
    storage.setItem(tokenKey, JSON.stringify({
      version: 1,
      accessToken: "mdb_notifications",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000
    }));
    const subscribe = vi.fn().mockResolvedValue({
      toJSON: () => ({
        endpoint: "https://push.example/subscription",
        expirationTime: null,
        keys: { p256dh: "p256dh-key-material", auth: "auth-key-material" }
      })
    });
    const serviceWorker = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe
      }
    } as unknown as ServiceWorkerRegistration;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = String(request);
      if (url.endsWith("/v1/apps/register")) {
        return jsonResponse({
          application: {
            id: "00000000-0000-0000-0000-000000000001",
            name: "Worklog",
            homepage: "https://tasks.example",
            notifications: {
              criteria: [{ id: "task.ready" }, { id: "task.overdue" }]
            }
          }
        });
      }
      if (url.endsWith("/v1/notifications/vapid-public-key")) {
        return jsonResponse({ public_key: "AQID" });
      }
      if (url.endsWith("/v1/notifications/channels") && init?.method === "POST") {
        return jsonResponse({
          channel_id: "00000000-0000-0000-0000-000000000003",
          criteria: ["task.ready"]
        }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const manager = new MdbaseConnect({
      serverUrl,
      manifest,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;

    const registration = unwrapConnectOutcome(await connect.registerNotifications({
      serviceWorker,
      criteria: ["task.ready"],
      installationId: "installation-0000000001"
    }));

    expect(registration).toEqual({
      channelId: "00000000-0000-0000-0000-000000000003",
      installationId: "installation-0000000001",
      criteria: ["task.ready"]
    });
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3])
    });
    const channelRequest = fetchMock.mock.calls.find(
      ([request]) => String(request).endsWith("/v1/notifications/channels")
    );
    expect(JSON.parse(String(channelRequest?.[1]?.body))).toMatchObject({
      installation_id: "installation-0000000001",
      criteria: ["task.ready"],
      subscription: { endpoint: "https://push.example/subscription" }
    });
    expect((channelRequest?.[1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer mdb_notifications");
  });

  it("rejects undeclared criteria before asking the browser for push permission", async () => {
    const storage = new MemoryStorage();
    storage.setItem(tokenKey, JSON.stringify({
      version: 1,
      accessToken: "mdb_notifications",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000
    }));
    const getSubscription = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      application: {
        id: "00000000-0000-0000-0000-000000000001",
        name: "Worklog",
        homepage: "https://tasks.example",
        notifications: { criteria: [{ id: "task.ready" }] }
      }
    }));
    const manager = new MdbaseConnect({
      serverUrl,
      manifest,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;

    await expect(connect.registerNotifications({
      serviceWorker: {
        pushManager: { getSubscription }
      } as unknown as ServiceWorkerRegistration,
      criteria: ["task.private"]
    })).resolves.toMatchObject({
      ok: false,
      problem: { code: "notification_criterion_not_declared" }
    });
    expect(getSubscription).not.toHaveBeenCalled();
  });

  it("validates and displays the privacy-minimal service-worker payload", async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const payload = {
      type: "mdbase.notification",
      version: 1,
      signal_id: "inv_opaque",
      criterion_id: "task.ready",
      cursor: "42",
      presentation: {
        title: "A task is ready",
        body: "Open Worklog to review it.",
        tag: "task-ready"
      }
    };

    expect(parseMdbasePushPayload(payload)).toEqual(payload);
    await showMdbasePushNotification({ showNotification }, payload);
    expect(showNotification).toHaveBeenCalledWith("A task is ready", {
      body: "Open Worklog to review it.",
      tag: "task-ready",
      data: {
        type: "mdbase.notification",
        signal_id: "inv_opaque",
        criterion_id: "task.ready",
        cursor: "42"
      }
    });
    expect(JSON.stringify(showNotification.mock.calls[0])).not.toContain("path");
    expect(() => parseMdbasePushPayload({ ...payload, cursor: 42 }))
      .toThrowError(MdbaseConnectError);
  });

  it("registers an FCM installation without accepting a client-selected project", async () => {
    const storage = new MemoryStorage();
    storage.setItem(tokenKey, JSON.stringify({
      version: 1,
      accessToken: "mdb_notifications",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (request, init) => {
        const url = String(request);
        if (url.endsWith("/v1/apps/register")) {
          return jsonResponse({
            application: {
              id: "00000000-0000-0000-0000-000000000001",
              name: "Worklog",
              homepage: "https://tasks.example",
              notifications: {
                native_delivery: {
                  mode: "managed_fcm",
                  firebase_project_id: "tasks-production"
                },
                criteria: [{ id: "task.ready" }]
              }
            }
          });
        }
        if (
          url.endsWith("/v1/notifications/channels")
          && init?.method === "POST"
        ) {
          return jsonResponse({
            channel_id: "00000000-0000-0000-0000-000000000004",
            transport: "fcm",
            criteria: ["task.ready"]
          }, 201);
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    const manager = new MdbaseConnect({
      serverUrl,
      manifest,
      redirectUri: "dev.worklog.app://auth/mdbase/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;

    const registration = unwrapConnectOutcome(await connect.registerNativeNotifications({
      token: "fcm_registration_token_012345678901234567890123",
      installationId: "native-installation-0001"
    }));

    expect(registration).toEqual({
      channelId: "00000000-0000-0000-0000-000000000004",
      installationId: "native-installation-0001",
      transport: "fcm",
      criteria: ["task.ready"]
    });
    const request = fetchMock.mock.calls.find(
      ([value]) => String(value).endsWith("/v1/notifications/channels")
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      installation_id: "native-installation-0001",
      criteria: ["task.ready"],
      transport: "fcm",
      token: "fcm_registration_token_012345678901234567890123"
    });
    expect(String(request?.[1]?.body)).not.toContain("tasks-production");
  });

  it("keeps a native channel recoverable when authorization is unavailable during opt-out", async () => {
    const storage = new MemoryStorage();
    const registrationKey =
      `mdbase-connect:${serverUrl}:${manifestSource}:notifications:${TEST_COLLECTION_ID}:fcm`;
    storage.setItem(tokenKey, JSON.stringify({
      version: 1,
      accessToken: "expired",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: TEST_COLLECTION_ID,
      collectionName: "Worklog",
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000,
      savedAt: Date.now()
    }));
    storage.setItem(registrationKey, JSON.stringify({
      channelId: "00000000-0000-0000-0000-000000000004",
      installationId: "native-installation-0001",
      transport: "fcm",
      criteria: ["task.ready"]
    }));
    const manager = new MdbaseConnect({
      serverUrl,
      manifest,
      redirectUri: "dev.worklog.app://auth/mdbase/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;
    storage.removeItem(tokenKey);

    await expect(connect.unregisterNativeNotifications()).resolves.toMatchObject({
      ok: false,
      problem: { code: "not_authorized" }
    });
    expect(storage.getItem(registrationKey)).not.toBeNull();
  });

  it("normalizes string-valued native delivery data", () => {
    expect(parseMdbaseNativeNotificationData({
      type: "mdbase.notification",
      version: "1",
      signal_id: "signal_opaque",
      criterion_id: "task.ready",
      cursor: "42"
    })).toEqual({
      type: "mdbase.notification",
      version: 1,
      signal_id: "signal_opaque",
      criterion_id: "task.ready",
      cursor: "42"
    });
    expect(() => parseMdbaseNativeNotificationData({
      type: "mdbase.notification",
      version: "1",
      signal_id: "signal_opaque",
      criterion_id: "task.ready",
      cursor: 42
    })).toThrowError(MdbaseConnectError);
  });
});

describe("long mutation progress", () => {
  const renameInput = {
    from: "Notes/source.md",
    to: "Archive/source.md",
    updateRefs: true,
    ifRevision: "sha256:source"
  };
  const renamePreview = {
    from: renameInput.from,
    to: renameInput.to,
    dryRun: true as const,
    wouldRename: true as const,
    referencesAffected: [
      { path: "Notes/one.md", location: "body" },
      { path: "Notes/one.md", field: "related" },
      { path: "Notes/two.md", location: "body" }
    ],
    warnings: [{ path: "Notes/ambiguous.md", message: "Ambiguous link" }]
  };

  it("reports authoritative phases and estimates without repeating a supplied preflight", async () => {
    const connect = progressConnection();
    const preflight = vi.spyOn(connect, "preflightRename");
    vi.spyOn(connect, "rename").mockResolvedValue(connectSuccess({
        from: renameInput.from,
        to: renameInput.to,
        path: renameInput.to,
        revision: "sha256:renamed",
        frontmatter: {},
        types: []
    }));
    const progress: Array<Record<string, unknown>> = [];

    const result = await connect.renameWithProgress(renameInput, {
      preflight: renamePreview,
      onProgress: (event) => progress.push(event as unknown as Record<string, unknown>)
    });

    expect(result).toMatchObject({ ok: true, value: { path: renameInput.to } });
    expect(preflight).not.toHaveBeenCalled();
    expect(progress.map(({ state }) => state)).toEqual([
      "preflighting",
      "ready",
      "applying",
      "completed"
    ]);
    expect(progress[1]).toMatchObject({
      cancellable: true,
      resumed: false,
      completedUnits: 0,
      estimate: { affectedRecords: 2, totalUnits: 4, warnings: 1 }
    });
    expect(progress.at(-1)).toMatchObject({
      cancellable: false,
      completedUnits: 4
    });
  });

  it("cancels between preflight and apply without dispatching the mutation", async () => {
    const connect = progressConnection();
    const rename = vi.spyOn(connect, "rename");
    const controller = new AbortController();
    const states: string[] = [];

    await expect(connect.renameWithProgress(renameInput, {
      preflight: renamePreview,
      signal: controller.signal,
      onProgress: (progress) => {
        states.push(progress.state);
        if (progress.state === "ready") controller.abort("user cancelled");
      }
    })).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "operation_cancelled",
        operation_outcome: "not_sent",
        recovery: "none"
      }
    });

    expect(rename).not.toHaveBeenCalled();
    expect(states).toEqual(["preflighting", "ready", "cancelled"]);
  });

  it("shares one monotonic timeout across progress preflight and apply", async () => {
    vi.useFakeTimers();
    const connect = progressConnection();
    let preflightOptions: { signal?: AbortSignal; timeoutMs?: number | null } | undefined;
    let applyOptions: { signal?: AbortSignal; timeoutMs?: number | null } | undefined;
    vi.spyOn(connect, "preflightRename").mockImplementation(async (_input, options) => {
      preflightOptions = options;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return connectSuccess(renamePreview);
    });
    vi.spyOn(connect, "rename").mockImplementation((_input, options) => {
      applyOptions = options;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(options?.signal?.reason);
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    });

    const pending = connect.renameWithProgress(renameInput, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(40);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      problem: { code: "timeout", operation_outcome: "not_sent" }
    });
    expect(preflightOptions).toMatchObject({ timeoutMs: null });
    expect(applyOptions).toMatchObject({ timeoutMs: null });
    expect(preflightOptions?.signal).toBe(applyOptions?.signal);
  });

  it("rejects a reused preflight for a different mutation", async () => {
    const connect = progressConnection();
    const rename = vi.spyOn(connect, "rename");

    await expect(connect.renameWithProgress(
      { ...renameInput, to: "Archive/different.md" },
      { preflight: renamePreview }
    )).resolves.toMatchObject({
      ok: false,
      problem: { code: "invalid_preflight", recovery: "refresh" }
    });
    expect(rename).not.toHaveBeenCalled();
  });

  it("does not estimate reference updates for a rename-only move", async () => {
    const connect = progressConnection();
    vi.spyOn(connect, "rename").mockResolvedValue(connectSuccess({
        from: renameInput.from,
        to: renameInput.to,
        path: renameInput.to,
        revision: "sha256:moved",
        frontmatter: {},
        types: []
    }));
    const progress: Array<{ state: string; estimate?: { affectedRecords: number; totalUnits: number } }> = [];

    await connect.renameWithProgress({ ...renameInput, updateRefs: false }, {
      preflight: renamePreview,
      onProgress: (event) => progress.push(event)
    });

    expect(progress.find(({ state }) => state === "ready")?.estimate).toMatchObject({
      affectedRecords: 0,
      totalUnits: 1
    });
  });
});

describe("application sessions", () => {
  it("selects the only saved collection during startup", async () => {
    const browser = installBrowser("https://tasks.example/today?filter=open#focus");
    const manager = managerWithConnections([TEST_COLLECTION_ID]);
    const session = new MdbaseSession(manager, {
      operations: ["query"],
      selection: new MdbaseBrowserSelection()
    });

    await session.start();

    expect(session.getSnapshot()).toMatchObject({
      status: "ready",
      collectionId: TEST_COLLECTION_ID
    });
    expect(new URL(browser.href()).searchParams.get("collection")).toBe(TEST_COLLECTION_ID);
    expect(browser.replaceState).toHaveBeenCalledOnce();
  });

  it("recovers atomically from a stale bookmark without reloading", async () => {
    const browser = installBrowser("https://tasks.example/today?collection=not-authorized");
    const manager = managerWithConnections([TEST_COLLECTION_ID]);
    const session = new MdbaseSession(manager, {
      operations: ["query"],
      selection: new MdbaseBrowserSelection()
    });
    await session.start();
    expect(session.getSnapshot()).toMatchObject({
      status: "unavailable",
      collectionId: "not-authorized",
      reason: "not_authorized"
    });

    const snapshots: string[] = [];
    session.subscribe(() => snapshots.push(session.getSnapshot().status));
    const selected = unwrapConnectOutcome(session.select(TEST_COLLECTION_ID));

    expect(selected.collectionId).toBe(TEST_COLLECTION_ID);
    expect(session.getSnapshot()).toMatchObject({
      status: "ready",
      collectionId: TEST_COLLECTION_ID
    });
    expect(new URL(browser.href()).searchParams.get("collection")).toBe(TEST_COLLECTION_ID);
    expect(snapshots).toEqual(["ready"]);
  });

  it("does not mutate selection when asked to open an unknown collection", async () => {
    const browser = installBrowser(`https://tasks.example/?collection=${TEST_COLLECTION_ID}`);
    const manager = managerWithConnections([TEST_COLLECTION_ID]);
    const session = new MdbaseSession(manager, { selection: new MdbaseBrowserSelection() });
    await session.start();

    expect(session.select("not-authorized")).toMatchObject({
      ok: false,
      problem: { code: "unknown_collection" }
    });
    expect(new URL(browser.href()).searchParams.get("collection")).toBe(TEST_COLLECTION_ID);
    expect(session.getSnapshot()).toMatchObject({
      status: "ready",
      collectionId: TEST_COLLECTION_ID
    });
  });

  it("publishes one unselected snapshot when forgetting the active collection", async () => {
    installBrowser(`https://tasks.example/?collection=${TEST_COLLECTION_ID}`);
    const manager = managerWithConnections([TEST_COLLECTION_ID]);
    const session = new MdbaseSession(manager, { selection: new MdbaseBrowserSelection() });
    await session.start();
    const snapshots: string[] = [];
    session.subscribe(() => snapshots.push(session.getSnapshot().status));

    session.forget(TEST_COLLECTION_ID);

    expect(session.getSnapshot()).toEqual({ status: "unselected", connections: [] });
    expect(snapshots).toEqual(["unselected"]);
  });

  it("reports an incompatible persisted grant instead of silently treating it as absent", async () => {
    installBrowser(`https://tasks.example/?collection=${TEST_COLLECTION_ID}`);
    const serverUrl = "https://connect.example";
    const manifest = "https://tasks.example/manifest.json";
    const storage = new MemoryStorage();
    storage.setItem(storedTokenKey(serverUrl, manifest, TEST_COLLECTION_ID), JSON.stringify({
      accessToken: "pre-release-token-without-a-storage-version"
    }));
    const manager = new MdbaseConnect({
      serverUrl,
      manifest,
      redirectUri: "https://tasks.example/callback",
      storage
    });
    const session = new MdbaseSession(manager, { selection: new MdbaseBrowserSelection() });

    await session.start();

    expect(session.getSnapshot()).toMatchObject({
      status: "unavailable",
      collectionId: TEST_COLLECTION_ID,
      reason: "invalid_stored_grant"
    });
  });

  it("invalidates a pre-final relay grant before reading obsolete key fields", async () => {
    installBrowser(`https://tasks.example/?collection=${TEST_COLLECTION_ID}`);
    const serverUrl = "https://connect.example";
    const manifest = "https://tasks.example/manifest.json";
    const storage = new MemoryStorage();
    storage.setItem(storedTokenKey(serverUrl, manifest, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "pre-final-relay-token",
      refreshToken: "pre-final-refresh-token",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: TEST_COLLECTION_ID,
      collectionName: "Stale relay collection",
      operations: ["describe", "query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000,
      grantId: "00000000-0000-0000-0000-000000000003",
      encryption: {
        protocol_version: 1,
        suite: "P256-HKDF-SHA256-AES256GCM",
        key_id: "pre-final-key",
        scope_epoch: 1,
        connector_id: "00000000-0000-0000-0000-000000000004",
        collection_id: TEST_COLLECTION_ID,
        application_public_key: "obsolete",
        connector_public_key: "obsolete"
      },
      keyHandle: "pre-final-key",
      savedAt: Date.now()
    }));
    storage.setItem(
      `mdbase-connect:${serverUrl}:${manifest}:connections`,
      storedConnectionIndex([TEST_COLLECTION_ID])
    );
    const manager = new MdbaseConnect({
      serverUrl,
      manifest,
      redirectUri: "https://tasks.example/callback",
      storage
    });
    const session = new MdbaseSession(manager, {
      selection: new MdbaseBrowserSelection()
    });

    await session.start();

    expect(session.getSnapshot()).toMatchObject({
      status: "unavailable",
      collectionId: TEST_COLLECTION_ID,
      reason: "invalid_stored_grant"
    });
    expect(
      storage.getItem(storedTokenKey(serverUrl, manifest, TEST_COLLECTION_ID))
    ).toBeNull();
  });

  it("keeps choose and exact authorization intents distinct", async () => {
    installBrowser(`https://tasks.example/?collection=${TEST_COLLECTION_ID}`);
    const manager = managerWithConnections([TEST_COLLECTION_ID]);
    const authorize = vi.spyOn(manager, "authorize").mockResolvedValue(
      connectSuccess({ kind: "redirecting" })
    );
    const session = new MdbaseSession(manager, {
      operations: ["query", "update"],
      selection: new MdbaseBrowserSelection()
    });
    await session.start();

    await session.authorize("choose");
    await session.authorize("selected");
    await session.authorize({ collectionId: "adopted-collection" });

    expect(authorize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      target: { kind: "choose" }
    }));
    expect(authorize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      target: { kind: "collection", collectionId: TEST_COLLECTION_ID }
    }));
    expect(authorize).toHaveBeenNthCalledWith(3, expect.objectContaining({
      target: { kind: "collection", collectionId: "adopted-collection" }
    }));
  });

  it("keeps app navigation bookmarkable, preserves history state, and strips OAuth parameters", () => {
    const browser = installBrowser(
      "https://tasks.example/today?filter=open&code=temporary&state=pending#focus"
    );
    const selection = new MdbaseBrowserSelection();

    selection.select(TEST_COLLECTION_ID, { history: "push" });

    const selected = new URL(browser.href());
    expect(selected.pathname).toBe("/today");
    expect(selected.searchParams.get("filter")).toBe("open");
    expect(selected.searchParams.get("collection")).toBe(TEST_COLLECTION_ID);
    expect(selected.searchParams.has("code")).toBe(false);
    expect(selected.searchParams.has("state")).toBe(false);
    expect(selected.hash).toBe("#focus");
    expect(selection.authorizationReturnTo()).toBe(
      `/today?filter=open&collection=${TEST_COLLECTION_ID}#focus`
    );
    expect(browser.pushState).toHaveBeenCalledWith(
      { router: "preserved" },
      "",
      expect.any(URL)
    );
  });

  it("finishes authorization at a safe app-local return location", async () => {
    const browser = installBrowser("https://tasks.example/auth/mdbase/callback?code=one&state=two");
    const manager = managerWithConnections([TEST_COLLECTION_ID]);
    const connection = manager.connection(TEST_COLLECTION_ID)!;
    vi.spyOn(manager, "completeAuthorization").mockResolvedValue(connectSuccess({
      connection,
      returnTo: "/search?q=next&error=stale#result"
    }));
    const session = new MdbaseSession(manager, {
      selection: new MdbaseBrowserSelection({ fallbackPath: "/app/" })
    });

    await expect(session.start()).resolves.toMatchObject({
      ok: true,
      value: { status: "ready", collectionId: TEST_COLLECTION_ID }
    });
    const completed = new URL(browser.href());
    expect(completed.pathname).toBe("/search");
    expect(completed.searchParams.get("q")).toBe("next");
    expect(completed.searchParams.get("collection")).toBe(TEST_COLLECTION_ID);
    expect(completed.searchParams.has("error")).toBe(false);
    expect(completed.hash).toBe("#result");

    vi.mocked(manager.completeAuthorization).mockResolvedValue(connectSuccess({
      connection,
      returnTo: "https://other.example/steal"
    }));
    browser.navigate("https://tasks.example/auth/mdbase/callback?code=two&state=three");
    await session.handleAuthorizationCallback(browser.href());
    expect(new URL(browser.href()).pathname).toBe("/app/");
  });

  it("reports browser back and forward selection changes", () => {
    const secondId = "00000000-0000-0000-0000-000000000003";
    const browser = installBrowser(
      `https://tasks.example/?collection=${TEST_COLLECTION_ID}`
    );
    const manager = managerWithConnections([TEST_COLLECTION_ID, secondId]);
    const session = new MdbaseSession(manager, {
      selection: new MdbaseBrowserSelection()
    });
    const changes: Array<string | null> = [];
    const stop = session.subscribe(() => {
      const snapshot = session.getSnapshot();
      changes.push(snapshot.status === "ready" ? snapshot.collectionId : null);
    });
    void session.start();

    browser.navigate(`https://tasks.example/?collection=${secondId}`, true);
    expect(changes).toEqual([secondId]);

    stop();
    browser.navigate(`https://tasks.example/?collection=${TEST_COLLECTION_ID}`, true);
    expect(changes).toEqual([secondId]);
  });

  it("recognizes only authorization-shaped callbacks and cleans denied URLs", () => {
    const browser = installBrowser(
      "https://tasks.example/auth/mdbase/callback?error=access_denied&state=one"
    );
    const selection = new MdbaseBrowserSelection();

    expect(selection.authorizationCallback()).toBe(browser.href());

    selection.clearAuthorizationCallback();
    const cleaned = new URL(browser.href());
    expect(cleaned.searchParams.has("error")).toBe(false);
    expect(cleaned.searchParams.has("state")).toBe(false);
  });

  it("does not treat an ordinary application error parameter as an authorization callback", () => {
    installBrowser("https://tasks.example/search?error=no-results");

    expect(new MdbaseBrowserSelection().authorizationCallback()).toBeNull();
  });
});

describe("authorization renewal", () => {
  it("keeps independent collection-bound connections and forgets only the selected one", () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/manifest.json";
    const secondId = "00000000-0000-0000-0000-000000000003";
    for (const [collectionId, collectionName] of [
      [TEST_COLLECTION_ID, "Home tasks"],
      [secondId, "Studio tasks"]
    ]) {
      storage.setItem(storedTokenKey(serverUrl, manifestUrl, collectionId), JSON.stringify({
        version: 1,
        accessToken: `token-${collectionId}`,
        clientId: "00000000-0000-0000-0000-000000000001",
        collectionId,
        collectionName,
        operations: ["query"],
        scope: { contracts: [], access: "full_collection" },
        expiresAt: Date.now() + 60_000,
        savedAt: Date.now()
      }));
    }
    storage.setItem(
      `mdbase-connect:${serverUrl}:${manifestUrl}:connections`,
      storedConnectionIndex([secondId, TEST_COLLECTION_ID])
    );
    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });

    expect(manager.connections().map(({ displayName }) => displayName)).toEqual([
      "Home tasks",
      "Studio tasks"
    ]);
    manager.connection(TEST_COLLECTION_ID)!.forget();
    expect(manager.connection(TEST_COLLECTION_ID)).toBeNull();
    expect(manager.connection(secondId)?.displayName).toBe("Studio tasks");
  });

  it("drops saved authorizations that predate explicit collection scope", () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/manifest.json";
    const tokenKey = storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID);
    storage.setItem(tokenKey, JSON.stringify({
      version: 1,
      accessToken: "legacy-token",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: TEST_COLLECTION_ID,
      collectionName: "Old tasks",
      operations: ["query"],
      expiresAt: Date.now() + 60_000,
      savedAt: Date.now(),
    }));
    storage.setItem(
      `mdbase-connect:${serverUrl}:${manifestUrl}:connections`,
      storedConnectionIndex([TEST_COLLECTION_ID]),
    );
    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
    });

    expect(manager.connection(TEST_COLLECTION_ID)).toBeNull();
    expect(manager.connections()).toEqual([]);
    expect(storage.getItem(tokenKey)).toBeNull();
  });

  it("passes an exact collection target and return location through authorization", async () => {
    const storage = new MemoryStorage();
    const navigate = vi.fn();
    let authorizationForm: URLSearchParams | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      if (String(request).endsWith("/v1/apps/register")) {
        return jsonResponse({ application: registeredApplication() });
      }
      authorizationForm = new URLSearchParams(String(init?.body));
      const proof = JSON.parse(authorizationForm.get("application_authorization")!);
      return jsonResponse({
        authorization_id: proof.binding.authorization_id,
        authorization_uri: `https://connect.example/oauth/authorize?request_id=${proof.binding.authorization_id}`,
        expires_in: 600,
        interval: 30
      });
    });
    const manager = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: {
        manifest_version: 1,
        id: "dev.tasks",
        name: "Tasks",
        homepage: "https://tasks.example/",
        redirect_uris: ["https://tasks.example/callback"]
      },
      redirectUri: "https://tasks.example/callback",
      storage,
      keyStore: new MemoryGrantKeyStore(),
      identityStore: new MemoryApplicationIdentityStore(),
      relayEncryption: "disabled",
      navigate
    });

    const controller = new AbortController();
    const outcome = manager.authorize({
      operations: ["query"],
      target: { kind: "collection", collectionId: TEST_COLLECTION_ID },
      returnTo: "/today?filter=open",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());

    expect(authorizationForm?.get("collection_id")).toBe(TEST_COLLECTION_ID);
    const proof = JSON.parse(authorizationForm!.get("application_authorization")!);
    const state = proof.binding.state;
    expect(JSON.parse(storage.getItem(
      `mdbase-connect:https://connect.example:bundle:dev.tasks:pending:${state}`
    )!)).toMatchObject({
      collectionId: TEST_COLLECTION_ID,
      returnTo: "/today?filter=open"
    });
    await expect(outcome).resolves.toMatchObject({
      ok: true,
      value: { kind: "redirecting" }
    });
  });

  it("returns a typed problem when persistent application identity is unavailable", async () => {
    const keyStore = new MemoryGrantKeyStore();
    const deleteKey = vi.spyOn(keyStore, "delete");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      application: registeredApplication()
    }));
    const manager = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: {
        manifest_version: 1,
        id: "dev.tasks",
        name: "Tasks",
        homepage: "https://tasks.example/",
        redirect_uris: ["https://tasks.example/callback"]
      },
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage(),
      keyStore,
      identityStore: {
        async get() { throw new Error("identity database unavailable"); },
        async create() { throw new Error("identity database unavailable"); },
        async delete() {}
      },
      relayEncryption: "disabled",
      navigate: vi.fn()
    });

    await expect(manager.authorize({ operations: ["query"] })).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "application_identity_unavailable",
        category: "compatibility",
        recovery: "upgrade_application"
      }
    });
    expect(deleteKey).toHaveBeenCalledOnce();
  });

  it("cleans up a denied authorization without disturbing saved connections", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    const pendingKey = `mdbase-connect:${serverUrl}:${manifestUrl}:pending:denied-state`;
    storage.setItem(pendingKey, JSON.stringify({
      version: 1,
      verifier: "pkce-verifier",
      state: "denied-state",
      clientId: "00000000-0000-0000-0000-000000000001",
      redirectUri: "https://tasks.example/callback",
      relayEncryption: "disabled",
      returnTo: "/today"
    }));
    storage.setItem(storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "mdb_saved",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: TEST_COLLECTION_ID,
      collectionName: "Saved tasks",
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000,
      savedAt: Date.now()
    }));
    storage.setItem(
      `mdbase-connect:${serverUrl}:${manifestUrl}:connections`,
      storedConnectionIndex([TEST_COLLECTION_ID])
    );
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });

    await expect(manager.completeAuthorization(
      "https://tasks.example/callback?error=access_denied&error_description=Not%20now&state=denied-state"
    )).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "access_denied",
        message: "Not now",
        details: { return_to: "/today" }
      }
    });

    expect(storage.getItem(pendingKey)).toBeNull();
    expect(manager.connection(TEST_COLLECTION_ID)?.displayName).toBe("Saved tasks");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent authorization completion into one code exchange", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:${serverUrl}:${manifestUrl}:pending:callback-state`, JSON.stringify({
      version: 1,
      verifier: "pkce-verifier",
      state: "callback-state",
      clientId: "00000000-0000-0000-0000-000000000001",
      redirectUri: "https://tasks.example/callback",
      relayEncryption: "disabled"
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      access_token: "mdb_authorized",
      refresh_token: "ref_authorized",
      expires_in: 3600,
      refresh_expires_in: 2_592_000,
      collection_id: TEST_COLLECTION_ID,
      collection_name: "Tasks",
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connect = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const callback = "https://tasks.example/callback?code=single-use-code&state=callback-state";

    const [first, second] = await Promise.all([
      connect.completeAuthorization(callback),
      connect.completeAuthorization(callback)
    ]);

    expect(first).toEqual(second);
    const completed = unwrapConnectOutcome(first);
    expect(completed.connection.info()).toMatchObject({
      collectionId: TEST_COLLECTION_ID,
      displayName: "Tasks",
      operations: ["query"]
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports capability gaps and requests only the least-privilege union", async () => {
    const storage = new MemoryStorage();
    const navigate = vi.fn();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "mdb_current",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query", "read"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000
    }));
    let authorizationForm: URLSearchParams | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      if (String(request) === manifestUrl) return jsonResponse({
            manifest_version: 1,
            id: "dev.worklog.app",
            name: "Worklog",
            homepage: "https://tasks.example",
            redirect_uris: ["dev.worklog.app://auth/mdbase/callback"]
          });
      if (String(request).endsWith("/v1/apps/register")) return jsonResponse({
            application: registeredApplication({
              name: "Worklog",
              homepage: "https://tasks.example"
            })
          });
      authorizationForm = new URLSearchParams(String(init?.body));
      const proof = JSON.parse(authorizationForm.get("application_authorization")!);
      return jsonResponse({
        authorization_id: proof.binding.authorization_id,
        authorization_uri: `https://connect.example/oauth/authorize?request_id=${proof.binding.authorization_id}`,
        expires_in: 600,
        interval: 30
      });
    });
    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "dev.worklog.app://auth/mdbase/callback",
      storage,
      keyStore: new MemoryGrantKeyStore(),
      identityStore: new MemoryApplicationIdentityStore(),
      relayEncryption: "disabled",
      navigate
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;

    expect(connect.authorizationCapabilities(["read", "update", "update"])).toEqual({
      authorized: true,
      sufficient: false,
      collectionId: "00000000-0000-0000-0000-000000000002",
      grantedOperations: ["query", "read"],
      missingOperations: ["update"]
    });
    expect(connect.hasOperations(["query", "read"])).toBe(true);
    await connect.requestOperations(["read"]);
    expect(navigate).not.toHaveBeenCalled();

    const controller = new AbortController();
    const outcome = connect.requestOperations(["read", "update"], {
      signal: controller.signal
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(authorizationForm?.get("operations")).toBe("query,read,update");
    controller.abort();
    await outcome;
  });

  it("attaches the exact capability gap to insufficient-access errors", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "mdb_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000
    }));
    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;

    await expect(connect.read({ path: "Notes/example.md" })).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "insufficient_access",
        category: "authorization",
        recovery: "reauthorize",
        details: {
          required_operations: ["read"],
          granted_operations: ["query"],
          missing_operations: ["read"]
        }
      }
    });
  });

  it("uses injected navigation for native authorization", async () => {
    const storage = new MemoryStorage();
    const navigate = vi.fn();
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    let authorizationForm: URLSearchParams | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      if (String(request) === manifestUrl) return jsonResponse({
            manifest_version: 1,
            id: "dev.worklog.app",
            name: "Worklog",
            homepage: "https://tasks.example",
            redirect_uris: ["dev.worklog.app://auth/mdbase/callback"]
          });
      if (String(request).endsWith("/v1/apps/register")) return jsonResponse({
            application: registeredApplication({
              name: "Worklog",
              homepage: "https://tasks.example"
            })
          });
      authorizationForm = new URLSearchParams(String(init?.body));
      const proof = JSON.parse(authorizationForm.get("application_authorization")!);
      return jsonResponse({
        authorization_id: proof.binding.authorization_id,
        authorization_uri: `https://connect.example/oauth/authorize?request_id=${proof.binding.authorization_id}`,
        expires_in: 600,
        interval: 30
      });
    });
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: manifestUrl,
      redirectUri: "dev.worklog.app://auth/mdbase/callback",
      storage,
      keyStore: new MemoryGrantKeyStore(),
      identityStore: new MemoryApplicationIdentityStore(),
      relayEncryption: "disabled",
      navigate
    });

    const controller = new AbortController();
    const outcome = connect.authorize({
      operations: ["query"],
      signal: controller.signal
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(authorizationForm?.get("redirect_uri"))
      .toBe("dev.worklog.app://auth/mdbase/callback");
    controller.abort();
    await outcome;
  });

  it("sends hosted operations directly to the provider with its scoped capability", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const providerUrl = "https://provider.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "mdb_control",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query"],
      scope: {
        contracts: [WORK_ITEM_CONTRACT],
        access: "contract",
      },
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000,
      authority: {
        operationsUrl: `${providerUrl}/v1/authorities/00000000-0000-0000-0000-000000000002/operations`,
        syncUrl: `${providerUrl}/v1/authorities/00000000-0000-0000-0000-000000000002/sync`,
        filesUrl: `${providerUrl}/v1/authorities/00000000-0000-0000-0000-000000000002/files`,
        replicaId: "00000000-0000-0000-0000-000000000003",
        version: 1,
        accessToken: "hsa_direct"
      }
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
      const operation = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        protocol_version: 2,
        request_id: operation.request_id,
        ok: true,
        result: { valid: true, result: { results: [] }, diagnostics: [] }
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;

    expect((await connect.query()).ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${providerUrl}/v1/authorities/00000000-0000-0000-0000-000000000002/operations/query`
    );
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer hsa_direct");
  });

  it("keeps hosted sync credentials private and refreshes them for the offline transport", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const providerUrl = "https://provider.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "mdb_control",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query", "create", "update", "delete"],
      scope: {
        contracts: [WORK_ITEM_CONTRACT],
        access: "contract",
      },
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000,
      authority: {
        operationsUrl: `${providerUrl}/v1/authorities/00000000-0000-0000-0000-000000000002/operations`,
        syncUrl: `${providerUrl}/v1/authorities/00000000-0000-0000-0000-000000000002/sync`,
        filesUrl: `${providerUrl}/v1/authorities/00000000-0000-0000-0000-000000000002/files`,
        replicaId: "00000000-0000-0000-0000-000000000003",
        version: 1,
        accessToken: "hsa_direct"
      }
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
      protocol_profile: "exact_document_v1",
      session_id: "00000000-0000-0000-0000-000000000004",
      replica_id: "00000000-0000-0000-0000-000000000003",
      collection_id: "00000000-0000-0000-0000-000000000002",
      mode: "read_write",
      scope_epoch: 1,
      retained_after: 0,
      head: 0,
      snapshot_id: "00000000-0000-0000-0000-000000000005",
      resources: { revision: "one", spec_version: "0.3.0", types: [], contracts: [] }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;

    const sync = connect.sync();
    expect(sync).toEqual(expect.objectContaining({
      collectionId: "00000000-0000-0000-0000-000000000002",
      replicaId: "00000000-0000-0000-0000-000000000003"
    }));
    expect(JSON.stringify(sync)).not.toContain("hsa_direct");
    expect((await sync!.transport.openSession()).mode).toBe("read_write");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${providerUrl}/v1/authorities/00000000-0000-0000-0000-000000000002/sync/sessions`
    );
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer hsa_direct");
  });

  it("rotates an expired access token and retries with the renewed credential", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "mdb_expired",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query"],
      scope: {
        contracts: [WORK_ITEM_CONTRACT],
        access: "contract",
      },
      expiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() + 60_000
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "mdb_renewed",
        refresh_token: "ref_rotated",
        expires_in: 3600,
        refresh_expires_in: 2_592_000,
        collection_id: "00000000-0000-0000-0000-000000000002",
        operations: ["query"],
        scope: {
          contracts: [WORK_ITEM_CONTRACT],
          access: "contract",
        }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockImplementationOnce(async (_request, init) => {
        const operation = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          protocol_version: 2,
          request_id: operation.request_id,
          ok: true,
          result: { valid: true, result: { results: [] }, diagnostics: [] }
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;
    const result = await connect.query();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${serverUrl}/oauth/token`);
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer mdb_renewed");
    expect(JSON.parse(storage.getItem(storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID))!))
      .toEqual(expect.objectContaining({ accessToken: "mdb_renewed", refreshToken: "ref_rotated" }));
  });

  it("uses a refresh credential rotated by another browser tab", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    const tokenKey = storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID);
    const baseToken = {
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      collectionName: "Worklog",
      operations: ["query"],
      scope: {
        contracts: [WORK_ITEM_CONTRACT],
        access: "contract",
      },
      refreshExpiresAt: Date.now() + 60_000
    };
    storage.setItem(tokenKey, JSON.stringify({
      ...baseToken,
      version: 1,
      accessToken: "mdb_expired",
      refreshToken: "ref_old",
      expiresAt: Date.now() - 1
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        storage.setItem(tokenKey, JSON.stringify({
          ...baseToken,
          version: 1,
          accessToken: "mdb_from_other_tab",
          refreshToken: "ref_from_other_tab",
          expiresAt: Date.now() + 3_600_000
        }));
        return new Response(JSON.stringify({
          error: { code: "invalid_grant", message: "Refresh token has already been used." }
        }), { status: 400, headers: { "content-type": "application/json" } });
      })
      .mockImplementationOnce(async (_request, init) => {
        const operation = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          protocol_version: 2,
          request_id: operation.request_id,
          ok: true,
          result: { valid: true, result: { results: [] }, diagnostics: [] }
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;
    const result = await connect.query();

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer mdb_from_other_tab");
    expect(JSON.parse(storage.getItem(tokenKey)!))
      .toEqual(expect.objectContaining({ refreshToken: "ref_from_other_tab" }));
  });

  it("maps an invalid refresh grant to the public authorization-expired problem", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(storedTokenKey(serverUrl, manifestUrl, TEST_COLLECTION_ID), JSON.stringify({
      version: 1,
      accessToken: "mdb_expired",
      refreshToken: "ref_revoked",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: TEST_COLLECTION_ID,
      collectionName: "Worklog",
      operations: ["query"],
      scope: { contracts: [WORK_ITEM_CONTRACT], access: "contract" },
      expiresAt: Date.now() - 1,
      refreshExpiresAt: Date.now() + 60_000
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "invalid_grant", message: "Refresh token is invalid or expired." }
    }), { status: 400, headers: { "content-type": "application/json" } }));
    const manager = new MdbaseConnect({
      serverUrl,
      manifest: manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      relayEncryption: "disabled"
    });
    const connect = manager.connection(TEST_COLLECTION_ID)!;

    await expect(connect.query()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "authorization_expired",
        category: "authorization",
        recovery: "reauthorize"
      }
    });
    expect(manager.connections()).toEqual([]);
  });
});

describe("direct loopback routing", () => {
  it("classifies a relay network failure without throwing", async () => {
    const fixture = await encryptedConnection();
    fixture.connect.disableDirectAccess();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("relay unavailable"));

    await expect(fixture.connect.query()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "relay_unavailable",
        category: "availability",
        recovery: "retry"
      }
    });
  });

  it("marks a relay write as unknown when its network response is lost", async () => {
    const fixture = await encryptedConnection();
    fixture.connect.disableDirectAccess();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("relay response lost"));

    const outcome = await fixture.connect.create({
      path: "uncertain.md",
      frontmatter: { title: "Uncertain" }
    });
    expect(outcome).toMatchObject({
      ok: false,
      problem: {
        code: "operation_outcome_unknown",
        operation_outcome: "unknown",
        recovery: "resolve_outcome",
        details: { request_id: expect.any(String) }
      }
    });
    const pending = fixture.connect.pendingMutations()[0];
    expect(pending).toMatchObject({
      requestId: expect.any(String),
      operation: "create",
      fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      status: "outcome_unknown",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    });
    expect(fixture.connect.pendingMutations()).toHaveLength(1);
    expect(outcome.ok ? undefined : outcome.problem.details?.request_id).toBe(pending?.requestId);
  });

  it("tracks multiple unknown writes and recovers an exact encrypted envelope", async () => {
    const fixture = await encryptedConnection();
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        throw new TypeError("loopback response was lost");
      })
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "connector_offline", message: "Connector offline." }
        }), { status: 503, headers: { "content-type": "application/json" } });
      })
      .mockImplementation(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        throw new TypeError("relay response lost");
      });

    await expect(fixture.connect.create({
      path: "one.md",
      frontmatter: { title: "Only once" }
    })).resolves.toMatchObject({
      ok: false,
      problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:28485/v1/operations",
      `${fixture.serverUrl}/v1/authorities/${fixture.collectionId}/operations/create`
    ]);
    expect(requests[0].body).toBe(requests[1].body);
    expect(JSON.parse(requests[0].body)).toEqual(expect.objectContaining({
      type: "encrypted_operation_request",
      operation: "create",
      counter: "1"
    }));
    const firstPending = fixture.connect.pendingMutations()[0]!;

    await expect(fixture.connect.createType({
      document: `---
kind: mdbase.type
name: different
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
---
`
    })).resolves.toMatchObject({
      ok: false,
      problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
    });
    const pending = fixture.connect.pendingMutations();
    expect(pending.map(({ operation }) => operation).sort()).toEqual(["create", "create_type"]);
    expect(new Set(pending.map(({ requestId }) => requestId)).size).toBe(2);
    expect(requests[2].body).not.toBe(requests[0].body);

    fetchMock
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "connector_offline", message: "Connector offline." }
        }), { status: 503, headers: { "content-type": "application/json" } });
      });
    await expect(firstPending.recover()).resolves.toMatchObject({
      ok: false,
      problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
    });
    expect(requests.at(-1)!.body).toBe(requests[0].body);
    expect(fixture.connect.pendingMutations()).toHaveLength(2);
  });

  it("keeps an exact encrypted mutation resumable when waiting is cancelled after dispatch", async () => {
    const fixture = await encryptedConnection();
    const controller = new AbortController();
    const input = { path: "cancelled.md", frontmatter: { title: "Cancelled wait" } };
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (request, init) => {
      requests.push({ url: String(request), body: String(init?.body) });
      controller.abort("stop waiting");
      throw new DOMException("The operation was aborted", "AbortError");
    });

    await expect(fixture.connect.create(input, {
      signal: controller.signal
    })).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "operation_outcome_unknown",
        operation_outcome: "unknown",
        recovery: "resolve_outcome"
      }
    });
    const pending = fixture.connect.pendingMutations()[0];
    expect(pending).toMatchObject({
      requestId: expect.any(String),
      operation: "create",
      fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      status: "outcome_unknown",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    });
    expect(fixture.connect.pendingMutations()).toHaveLength(1);

    fetchMock
      .mockImplementationOnce(async (request, init) => {
        requests.push({ url: String(request), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "upgrade_required", message: "Use the relay." }
        }), { status: 426, headers: { "content-type": "application/json" } });
      })
      .mockImplementationOnce(async (request, init) => {
        requests.push({ url: String(request), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "connector_offline", message: "Connector offline." }
        }), { status: 503, headers: { "content-type": "application/json" } });
      });

    await expect(pending!.recover()).resolves.toMatchObject({
      ok: false,
      problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:28485/v1/operations",
      "http://127.0.0.1:28485/v1/operations",
      `${fixture.serverUrl}/v1/authorities/${fixture.collectionId}/operations/create`
    ]);
    expect(new Set(requests.map(({ body }) => body))).toHaveLength(1);
    expect(fixture.connect.pendingMutation(pending!.requestId)).toMatchObject({ operation: "create" });
  });

  it("retains unknown recovery state and its grant key across authorization loss", async () => {
    const fixture = await encryptedConnection();
    fixture.connect.disableDirectAccess();
    const storedToken = fixture.storage.getItem(fixture.tokenKey)!;
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("mutation response lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "direct_operation_rejected", message: "Grant revoked." }
      }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.create({ path: "retained.md", frontmatter: {} }))
      .resolves.toMatchObject({
        ok: false,
        problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
      });
    const requestId = fixture.connect.pendingMutations()[0]!.requestId;
    await expect(fixture.connect.query()).resolves.toMatchObject({
      ok: false,
      problem: { code: "direct_operation_rejected" }
    });

    expect(fixture.storage.getItem(fixture.tokenKey)).toBeNull();
    expect(Array.from({ length: fixture.storage.length }, (_, index) => fixture.storage.key(index)))
      .toContainEqual(expect.stringContaining(`:${requestId}`));
    await expect(fixture.keyStore.get("grant-key")).resolves.not.toBeNull();

    fixture.storage.setItem(fixture.tokenKey, storedToken);
    expect(fixture.connect.pendingMutation(requestId)).toMatchObject({ requestId });
  });

  it("does not bypass an explicit rejection from the local authorization boundary", async () => {
    const fixture = await encryptedConnection();
    const connectionChanges: Array<ReturnType<typeof fixture.connect.info>> = [];
    fixture.connect.onConnectionChange((connection) => connectionChanges.push(connection));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "direct_operation_rejected", message: "Rejected locally." }
    }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "direct_operation_rejected",
        category: "authorization",
        recovery: "reauthorize"
      }
    });
    expect(connectionChanges[0]).toEqual(expect.objectContaining({
      collectionId: fixture.collectionId
    }));
    expect(connectionChanges.at(-1)).toBeNull();
    expect(connectionChanges.filter((connection) => connection === null)).toHaveLength(1);
    expect(fixture.connect.info()).toBeNull();
    expect(fixture.storage.getItem(fixture.tokenKey)).toBeNull();
    await expect(fixture.keyStore.get("grant-key")).resolves.toBeNull();
    expect(fixture.connect.authorizationCapabilities(["query"])).toMatchObject({
      authorized: false,
      sufficient: false,
      missingOperations: ["query"]
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:28485/v1/operations");
  });

  it("clears a definitively rejected write without reporting an unknown outcome", async () => {
    const fixture = await encryptedConnection();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "direct_operation_rejected", message: "Rejected locally." }
    }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.create({
      path: "rejected.md",
      frontmatter: {},
      body: ""
    })).resolves.toMatchObject({
      ok: false,
      problem: {
        code: "direct_operation_rejected",
        category: "authorization",
        recovery: "reauthorize"
      }
    });
    expect(fixture.connect.pendingMutations()).toEqual([]);
    expect(fixture.connect.info()).toBeNull();
  });

  it("backs off an unavailable loopback route while keeping relay operations usable", async () => {
    const fixture = await encryptedConnection();
    const urls: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (input) => {
        urls.push(String(input));
        throw new TypeError("connector absent");
      })
      .mockImplementation(async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify({
          error: { code: "connector_offline", message: "Connector offline." }
        }), { status: 503, headers: { "content-type": "application/json" } });
      });

    await expect(fixture.connect.query()).resolves.toMatchObject({
      ok: false,
      problem: { code: "connector_offline" }
    });
    await expect(fixture.connect.query()).resolves.toMatchObject({
      ok: false,
      problem: { code: "connector_offline" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urls).toEqual([
      "http://127.0.0.1:28485/v1/operations",
      `${fixture.serverUrl}/v1/authorities/${fixture.collectionId}/operations/query`,
      `${fixture.serverUrl}/v1/authorities/${fixture.collectionId}/operations/query`
    ]);
  });

  it("renews a stale binding after an uncertain direct read without reporting an unknown write", async () => {
    const fixture = await encryptedConnection();
    const token = JSON.parse(fixture.storage.getItem(
      storedTokenKey(fixture.serverUrl, fixture.manifestUrl, fixture.collectionId)
    )!);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("loopback response was lost"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "encryption_binding_stale", message: "Refresh authorization." }
      }), { status: 409, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "mdb_refreshed",
        refresh_token: "ref_refreshed",
        expires_in: 3_600,
        refresh_expires_in: 7_200,
        collection_id: token.collectionId,
        operations: token.operations,
        scope: token.scope,
        grant_id: token.grantId,
        encryption: token.encryption,
        application_origin: token.applicationOrigin
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "connector_offline", message: "Connector offline." }
      }), { status: 503, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).resolves.toMatchObject({
      ok: false,
      problem: { code: "connector_offline" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("checks generic readiness from a user gesture without sending ambient credentials", async () => {
    const fixture = await encryptedConnection();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      service: "mdbase-connect",
      loopback_protocol_version: 1,
      operation_transport_protocol_version: 2
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const changes: string[] = [];
    fixture.connect.onConnectionChange((connection) => {
      if (connection) changes.push(connection.directAccess);
    });

    await expect(fixture.connect.requestDirectAccess()).resolves.toMatchObject({
      ok: true,
      value: "available"
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit & { targetAddressSpace?: string };
    expect(init.credentials).toBe("omit");
    expect(init.targetAddressSpace).toBe("loopback");
    expect(changes).toContain("checking");
    expect(changes.at(-1)).toBe("available");
  });

  it("lets a user re-enable direct access after disabling it", async () => {
    const fixture = await encryptedConnection();
    fixture.connect.disableDirectAccess();
    expect(fixture.connect.info()?.directAccess).toBe("disabled");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      service: "mdbase-connect",
      loopback_protocol_version: 1,
      operation_transport_protocol_version: 2
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.requestDirectAccess()).resolves.toMatchObject({
      ok: true,
      value: "available"
    });
    expect(fixture.connect.info()?.directAccess).toBe("available");
  });

  it("keeps direct grant proof usable after every cloud credential expires", async () => {
    const fixture = await encryptedConnection();
    const tokenKey = storedTokenKey(fixture.serverUrl, fixture.manifestUrl, fixture.collectionId);
    const token = JSON.parse(fixture.storage.getItem(tokenKey)!);
    fixture.storage.setItem(tokenKey, JSON.stringify({
      ...token,
      expiresAt: Date.now() - 60_000,
      refreshExpiresAt: Date.now() - 30_000
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "direct_operation_rejected", message: "Reached the connector." }
    }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).resolves.toMatchObject({
      ok: false,
      problem: { code: "direct_operation_rejected" }
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:28485/v1/operations");
    expect(fixture.storage.getItem(tokenKey)).toBeNull();
  });

  it("rejects loopback overrides that could escape the local machine", () => {
    expect(() => new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifest: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage(),
      loopbackUrl: "http://connector.evil.example:28485"
    })).toThrow(expect.objectContaining({ code: "invalid_loopback_url" }));
  });
});

describe("bounded watch subscriptions", () => {
  it("uses the configured watch-start default", async () => {
    vi.useFakeTimers();
    const connection = watchConnection({ watchStartMs: 25 });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => undefined)
    );

    const pending = connection.watch();
    const result = expect(pending).resolves.toMatchObject({
      ok: false,
      problem: { code: "timeout" }
    });
    await vi.advanceTimersByTimeAsync(25);
    await result;
  });

  it("bounds startup even when fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const connection = watchConnection();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => undefined)
    );

    const pending = connection.watch({}, { timeoutMs: 25 });
    const result = expect(pending).resolves.toMatchObject({
      ok: false,
      problem: { code: "timeout", operation_outcome: "not_sent" }
    });
    await vi.advanceTimersByTimeAsync(25);
    await result;
  });

  it("returns an abortable subscription and preserves startup events", async () => {
    const connection = watchConnection();
    const change = {
      cursor: 2,
      type: "mdbase.record.modified",
      occurred_at: "2026-08-04T00:00:00Z",
      payload: { path: "notes/one.md" }
    };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        return jsonResponse({
          protocol_version: 2,
          request_id: request.request_id,
          ok: true,
          result: { events: [change], cursor: 2, has_more: false }
        });
      })
      .mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }));

    const opened = await connection.watch({ cursor: 1 });
    expect(opened).toEqual(expect.objectContaining({ ok: true }));
    if (!opened.ok) return;
    const changes: unknown[] = [];
    const statuses: string[] = [];
    opened.value.subscribe((event) => changes.push(event), (status) => statuses.push(status.state));
    expect(changes).toEqual([{
      cursor: change.cursor,
      type: change.type,
      occurredAt: change.occurred_at,
      payload: change.payload
    }]);
    expect(statuses).toEqual(["connected"]);
    opened.value.close();
    expect(opened.value.status.state).toBe("closed");
  });
});

describe("durable pending mutation handles", () => {
  it("recovers the stored plaintext protocol request without reconstructed input", async () => {
    const connection = watchConnection();
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        bodies.push(String(init?.body));
        throw new TypeError("response lost after dispatch");
      })
      .mockImplementationOnce(async (_input, init) => {
        const body = String(init?.body);
        bodies.push(body);
        const request = JSON.parse(body);
        return jsonResponse({
          protocol_version: 2,
          request_id: request.request_id,
          ok: true,
          result: {
            valid: true,
            result: { path: "notes/recovered.md" },
            diagnostics: []
          }
        });
      });

    await expect(connection.create({ path: "notes/recovered.md", frontmatter: {} }))
      .resolves.toMatchObject({
        ok: false,
        problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
      });
    const pending = connection.pendingMutations<{ path: string }>();
    expect(pending).toHaveLength(1);
    await expect(pending[0]!.recover()).resolves.toMatchObject({
      ok: true,
      value: { path: "notes/recovered.md" }
    });
    expect(bodies[1]).toBe(bodies[0]);
    expect(connection.pendingMutations()).toEqual([]);
  });

  it("recovers and clears multiple unknown writes independently", async () => {
    const connection = watchConnection();
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_input, init) => {
        bodies.push(String(init?.body));
        throw new TypeError("first response lost");
      })
      .mockImplementationOnce(async (_input, init) => {
        bodies.push(String(init?.body));
        throw new TypeError("second response lost");
      })
      .mockImplementation(async (_input, init) => {
        const body = String(init?.body);
        bodies.push(body);
        const request = JSON.parse(body);
        return jsonResponse({
          protocol_version: 2,
          request_id: request.request_id,
          ok: true,
          result: {
            valid: true,
            result: { path: request.input.path },
            diagnostics: []
          }
        });
      });

    for (const path of ["notes/first.md", "notes/second.md"]) {
      await expect(connection.create({ path, frontmatter: {} })).resolves.toMatchObject({
        ok: false,
        problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
      });
    }
    const pending = connection.pendingMutations<{ path: string }>();
    expect(pending).toHaveLength(2);
    expect(new Set(pending.map(({ requestId }) => requestId)).size).toBe(2);

    await expect(pending[1]!.recover()).resolves.toMatchObject({
      ok: true,
      value: { path: expect.stringMatching(/^notes\//) }
    });
    expect(connection.pendingMutations().map(({ requestId }) => requestId))
      .toEqual([pending[0]!.requestId]);
    const recoveredSecond = JSON.parse(bodies[2]!).request_id;
    expect(bodies[2]).toBe(bodies.slice(0, 2).find((body) =>
      JSON.parse(body).request_id === recoveredSecond
    ));

    await expect(pending[0]!.recover()).resolves.toMatchObject({ ok: true });
    expect(connection.pendingMutations()).toEqual([]);
  });

  it("migrates the previous single-slot recovery record without losing its request", async () => {
    const storage = new MemoryStorage();
    const connection = watchConnection(undefined, storage);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("response lost"));

    await expect(connection.create({ path: "notes/legacy.md", frontmatter: {} }))
      .resolves.toMatchObject({
        ok: false,
        problem: { code: "operation_outcome_unknown", operation_outcome: "unknown" }
      });
    const requestId = connection.pendingMutations()[0]!.requestId;
    const requestKey = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .find((key) => key?.endsWith(`:${encodeURIComponent(requestId)}`))!;
    const legacyKey = requestKey.slice(0, -encodeURIComponent(requestId).length - 1);
    storage.setItem(legacyKey, storage.getItem(requestKey)!);
    storage.removeItem(requestKey);

    expect(connection.pendingMutations()).toMatchObject([{ requestId }]);
    expect(storage.getItem(legacyKey)).toBeNull();
    expect(storage.getItem(requestKey)).not.toBeNull();
  });
});

async function encryptedConnection() {
  const storage = new MemoryStorage();
  const keyStore = new MemoryGrantKeyStore();
  const connectorKeys = new MemoryGrantKeyStore();
  const application = await keyStore.create("grant-key");
  const connector = await connectorKeys.create("connector-key");
  const serverUrl = "https://connect.example";
  const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
  const collectionId = "01944444-4444-7444-8444-444444444444";
  const encryption: GrantEncryption = {
    protocol_version: 1,
    suite: "P256-HKDF-SHA256-AES256GCM",
    key_id: "enc_direct",
    scope_epoch: 1,
    connector_id: "01933333-3333-7333-8333-333333333333",
    collection_id: collectionId,
    application_agreement_public_key: application.agreementPublicKey,
    connector_agreement_public_key: connector.agreementPublicKey
  };
  const tokenKey = storedTokenKey(serverUrl, manifestUrl, collectionId);
  storage.setItem(tokenKey, JSON.stringify({
    version: 1,
    accessToken: "mdb_current",
    refreshToken: "ref_current",
    clientId: "01922222-2222-7222-8222-222222222222",
    collectionId,
    collectionName: "Encrypted notes",
    operations: [
      "describe", "changes", "read", "query", "list_views", "execute_view", "validate", "create", "update", "delete", "rename",
      "read_type", "create_type", "update_type"
    ],
    scope: { contracts: [], access: "full_collection" },
    expiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 120_000,
    grantId: "01911111-1111-7111-8111-111111111111",
    encryption,
    applicationOrigin: "https://tasks.example",
    keyHandle: "grant-key",
    savedAt: Date.now()
  }));
  storage.setItem("mdbase-connect:direct:https://tasks.example", "enabled");
  const manager = new MdbaseConnect({
    serverUrl,
    manifest: manifestUrl,
    redirectUri: "https://tasks.example/callback",
    storage,
    keyStore
  });
  return {
    serverUrl,
    manifestUrl,
    collectionId,
    storage,
    tokenKey,
    keyStore,
    connect: manager.connection(collectionId)!
  };
}

function progressConnection() {
  const serverUrl = "https://connect.example";
  const manifest = "https://tasks.example/manifest.json";
  const storage = new MemoryStorage();
  storage.setItem(storedTokenKey(serverUrl, manifest, TEST_COLLECTION_ID), JSON.stringify({
    version: 1,
    accessToken: "progress",
    clientId: "00000000-0000-0000-0000-000000000001",
    collectionId: TEST_COLLECTION_ID,
    collectionName: "Tasks",
    operations: ["rename", "delete"],
    scope: { contracts: [], access: "full_collection" },
    expiresAt: Date.now() + 60_000,
    grantId: "00000000-0000-0000-0000-000000000003",
    encryption: {
      protocol_version: 1,
      suite: "P256-HKDF-SHA256-AES256GCM",
      key_id: "progress-key",
      scope_epoch: 1,
      connector_id: "00000000-0000-0000-0000-000000000004",
      collection_id: TEST_COLLECTION_ID,
      application_agreement_public_key: "04".padEnd(130, "1"),
      connector_agreement_public_key: "04".padEnd(130, "2")
    },
    keyHandle: "progress-key",
    savedAt: Date.now()
  }));
  const manager = new MdbaseConnect({
    serverUrl,
    manifest,
    redirectUri: "https://tasks.example/callback",
    storage,
    keyStore: new MemoryGrantKeyStore(),
    relayEncryption: "disabled"
  });
  return manager.connection(TEST_COLLECTION_ID)!;
}

function watchConnection(
  timeouts?: import("./connect-options.js").MdbaseConnectTimeouts,
  storage = new MemoryStorage()
) {
  const serverUrl = "https://connect.example";
  const manifest = "https://tasks.example/manifest.json";
  storage.setItem(storedTokenKey(serverUrl, manifest, TEST_COLLECTION_ID), JSON.stringify({
    version: 1,
    accessToken: "watch-token",
    clientId: TEST_APPLICATION_ID,
    collectionId: TEST_COLLECTION_ID,
    collectionName: "Tasks",
    operations: ["changes", "create"],
    scope: { contracts: [], access: "full_collection" },
    expiresAt: Date.now() + 60_000,
    savedAt: Date.now()
  }));
  return new MdbaseConnect({
    serverUrl,
    manifest,
    redirectUri: "https://tasks.example/callback",
    storage,
    relayEncryption: "disabled",
    timeouts
  }).connection(TEST_COLLECTION_ID)!;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function portableManifest(): MdbaseAppManifest {
  return {
    manifest_version: 1,
    distribution: "portable",
    id: "dev.mdbase.portable-notes",
    name: "Portable notes",
    project_url: "https://apps.example/portable",
    requirements: {
      contracts: [],
      access: "full_collection"
    }
  };
}

function storedTokenKey(
  serverUrl: string,
  manifestSource: string,
  collectionId: string,
): string {
  return `mdbase-connect:${serverUrl}:${manifestSource}:token:${collectionId}`;
}

function managerWithConnections(collectionIds: string[]): MdbaseConnect {
  const serverUrl = "https://connect.example";
  const manifest = "https://tasks.example/manifest.json";
  const storage = new MemoryStorage();
  for (const collectionId of collectionIds) {
    storage.setItem(storedTokenKey(serverUrl, manifest, collectionId), JSON.stringify({
      version: 1,
      accessToken: `token-${collectionId}`,
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId,
      collectionName: `Collection ${collectionId.slice(-4)}`,
      operations: ["query"],
      scope: { contracts: [], access: "full_collection" },
      expiresAt: Date.now() + 60_000,
      savedAt: Date.now()
    }));
  }
  storage.setItem(
    `mdbase-connect:${serverUrl}:${manifest}:connections`,
    storedConnectionIndex(collectionIds)
  );
  return new MdbaseConnect({
    serverUrl,
    manifest,
    redirectUri: "https://tasks.example/auth/mdbase/callback",
    storage,
    relayEncryption: "disabled"
  });
}

function storedConnectionIndex(collectionIds: string[]): string {
  return JSON.stringify({ version: 1, collectionIds });
}

function installBrowser(initialUrl: string) {
  let current = new URL(initialUrl);
  const events = new EventTarget();
  const navigate = (value: string | URL, pop = false) => {
    current = new URL(String(value), current);
    if (pop) events.dispatchEvent(new Event("popstate"));
  };
  const pushState = vi.fn((_state: unknown, _unused: string, value?: string | URL | null) => {
    if (value !== undefined && value !== null) navigate(value);
  });
  const replaceState = vi.fn((_state: unknown, _unused: string, value?: string | URL | null) => {
    if (value !== undefined && value !== null) navigate(value);
  });
  vi.stubGlobal("location", {
    get href() { return current.href; },
    get origin() { return current.origin; }
  });
  vi.stubGlobal("history", {
    state: { router: "preserved" },
    pushState,
    replaceState
  });
  vi.stubGlobal("window", {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  });
  return {
    href: () => current.href,
    navigate,
    pushState,
    replaceState
  };
}
