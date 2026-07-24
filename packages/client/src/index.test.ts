import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPkce,
  MdbaseCollectionClient,
  MdbaseConnect,
  MdbaseConnectError,
  MdbaseOperationValidationError,
  isRetryableConnectError,
  MemoryGrantKeyStore,
  parseMdbasePushPayload,
  showMdbasePushNotification,
  unwrapOperation
} from "./index.js";
import type { GrantEncryption } from "@mdbase/connect-protocol";

afterEach(() => vi.restoreAllMocks());

describe("PKCE", () => {
  it("creates an OAuth S256 verifier and challenge", async () => {
    const pair = await createPkce();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("provider-neutral collection client", () => {
  it("sends the canonical v0.3 patch shape through an injected transport", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        return { valid: true, result: { path: "task.md" }, diagnostics: [] } as Result;
      }
    });
    await client.update({ path: "task.md", patch: { status: "done" }, if_revision: "revision:1" });
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
        return { valid: true, result: {}, diagnostics: [] } as Result;
      }
    });
    await client.readType({ name: "task" });
    await client.createType({ document: "---\nkind: mdbase.type\n---\n" });
    await client.updateType({
      path: "_types/task.md",
      document: "---\nkind: mdbase.type\n---\n",
      if_revision: "sha256:one"
    });
    expect(calls.map(({ operation }) => operation)).toEqual([
      "read_type",
      "create_type",
      "update_type"
    ]);
  });

  it("provides typed mutation preflights without changing normal mutation inputs", async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const client = new MdbaseCollectionClient({
      async operation<Result>(operation: string, input: unknown) {
        calls.push({ operation, input });
        return { valid: true, result: {}, diagnostics: [] } as Result;
      }
    });

    await client.preflightRename({ from: "old.md", to: "new.md", update_refs: true, if_revision: "revision:1" });
    await client.preflightDelete({ path: "old.md", if_revision: "revision:1" });
    await client.rename({ from: "old.md", to: "new.md", update_refs: false, if_revision: "revision:1" });

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
        return { valid: true, result: {}, diagnostics: [] } as Result;
      }
    });
    await client.listViews();
    await client.executeView({
      path: "TaskNotes/Views/tasks.base",
      view: "kanban-board",
      limit: 50
    });
    await client.readViewSource({ path: "TaskNotes/Views/tasks.base" });
    await client.createViewSource({
      path: "TaskNotes/Views/new.base",
      document: "views: []\n"
    });
    await client.updateViewSource({
      path: "TaskNotes/Views/tasks.base",
      if_revision: "sha256:one",
      document: "views: []\n"
    });
    await client.deleteViewSource({
      path: "TaskNotes/Views/tasks.base",
      if_revision: "sha256:two"
    });
    expect(calls).toEqual([
      { operation: "list_views", input: {} },
      {
        operation: "execute_view",
        input: {
          path: "TaskNotes/Views/tasks.base",
          view: "kanban-board",
          limit: 50
        }
      },
      {
        operation: "read_view_source",
        input: { path: "TaskNotes/Views/tasks.base" }
      },
      {
        operation: "create_view_source",
        input: {
          path: "TaskNotes/Views/new.base",
          document: "views: []\n"
        }
      },
      {
        operation: "update_view_source",
        input: {
          path: "TaskNotes/Views/tasks.base",
          if_revision: "sha256:one",
          document: "views: []\n"
        }
      },
      {
        operation: "delete_view_source",
        input: {
          path: "TaskNotes/Views/tasks.base",
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

    for await (const page of client.queryPages(
      { include_body: false, order_by: [{ field: "file.mtime", direction: "desc" }] },
      { firstPageSize: 1, pageSize: 2, onProgress: ({ loaded, complete }) => progress.push({ loaded, complete }) }
    )) {
      loaded.push(...page.results.map((record) => record.path));
    }

    expect(loaded).toEqual(["one.md", "two.md", "three.md"]);
    expect(progress).toEqual([{ loaded: 1, complete: false }, { loaded: 3, complete: true }]);
    expect(calls).toEqual([
      { include_body: false, order_by: [{ field: "file.mtime", direction: "desc" }], offset: 0, limit: 1 },
      { include_body: false, order_by: [{ field: "file.mtime", direction: "desc" }], offset: 1, limit: 2, snapshot: "stable-query" }
    ]);
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

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { snapshot: "snapshot-1" } });
    await expect(iterator.next()).rejects.toMatchObject({ code: "query_snapshot_changed", recovery: "refresh" });
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
    await expect(iterator.next()).rejects.toEqual(expect.objectContaining({
      code: "change_cursor_reset",
      recovery: "refresh"
    }));
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
        if (call === 2) throw new MdbaseConnectError("connector_offline", "Offline.", { status: 503 });
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
      value: { cursor: 6, type: "mdbase.record.modified" },
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
        throw new MdbaseConnectError("connector_offline", "Offline.", { status: 503 });
      }
    });
    const statuses: string[] = [];
    const iterator = client.watch({ retry: false, onStatus: (status) => statuses.push(status.state) });

    await expect(iterator.next()).rejects.toMatchObject({ code: "connector_offline" });
    expect(statuses).toEqual(["connecting"]);
  });

  it("requires browser-dependent defaults only when callers omit them", () => {
    expect(() => new MdbaseConnect({ serverUrl: "https://connect.example" }))
      .toThrow(MdbaseConnectError);
    expect(() => new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage()
    })).not.toThrow();
  });
});

describe("actionable SDK errors", () => {
  it("classifies retry, authorization, refresh, and uncertain-outcome recovery", () => {
    const offline = new MdbaseConnectError("connector_offline", "Connector offline.", { status: 503 });
    expect(offline).toMatchObject({
      name: "MdbaseConnectError",
      status: 503,
      retryable: true,
      requiresAuthorization: false,
      outcomeUnknown: false,
      recovery: "retry"
    });
    expect(isRetryableConnectError(offline)).toBe(true);
    expect(isRetryableConnectError(new TypeError("network unavailable"))).toBe(true);

    expect(new MdbaseConnectError("authorization_expired", "Reconnect.")).toMatchObject({
      retryable: false,
      requiresAuthorization: true,
      recovery: "reauthorize"
    });
    expect(new MdbaseConnectError("change_cursor_reset", "Refresh.")).toMatchObject({
      retryable: false,
      recovery: "refresh"
    });
    expect(new MdbaseConnectError("direct_outcome_unknown", "Check the write.")).toMatchObject({
      retryable: false,
      outcomeUnknown: true,
      recovery: "resolve_outcome"
    });
  });

  it("unwraps valid envelopes and preserves rejected diagnostics and partial results", () => {
    expect(unwrapOperation({ valid: true, result: { path: "notes/one.md" }, diagnostics: [] }))
      .toEqual({ path: "notes/one.md" });

    const envelope = {
      valid: false,
      result: { path: "notes/one.md", inspected: true },
      diagnostics: [
        { severity: "warning" as const, code: "deprecated", message: "A legacy field is present." },
        { severity: "error" as const, code: "missing_required", message: "Title is required.", field: "title" }
      ]
    };
    try {
      unwrapOperation(envelope);
      throw new Error("Expected unwrapOperation to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(MdbaseOperationValidationError);
      expect(error).toMatchObject({
        code: "operation_invalid",
        message: "Title is required.",
        diagnostics: envelope.diagnostics,
        result: envelope.result
      });
    }
  });

  it("keeps server status and diagnostic details on operation failures", async () => {
    const fixture = await encryptedConnection();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "connector_offline",
        message: "The connector is asleep.",
        details: { computer: "Studio" }
      }
    }), { status: 503, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).rejects.toMatchObject({
      code: "connector_offline",
      status: 503,
      retryable: true,
      recovery: "retry",
      details: { computer: "Studio" }
    });
  });
});

describe("mobile notifications", () => {
  const serverUrl = "https://connect.example";
  const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
  const tokenKey = `mdbase-connect:token:${serverUrl}:${manifestUrl}`;

  it("registers the selected criteria atomically for one browser installation", async () => {
    const storage = new MemoryStorage();
    storage.setItem(tokenKey, JSON.stringify({
      accessToken: "mdb_notifications",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [] },
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
      if (url.endsWith("/v1/apps/discover")) {
        return jsonResponse({
          application: {
            id: "00000000-0000-0000-0000-000000000001",
            name: "TaskNotes",
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
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });

    const registration = await connect.registerNotifications({
      serviceWorker,
      criteria: ["task.ready"],
      installationId: "installation-0000000001"
    });

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
      accessToken: "mdb_notifications",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [] },
      expiresAt: Date.now() + 60_000
    }));
    const getSubscription = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      application: {
        id: "00000000-0000-0000-0000-000000000001",
        name: "TaskNotes",
        homepage: "https://tasks.example",
        notifications: { criteria: [{ id: "task.ready" }] }
      }
    }));
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });

    await expect(connect.registerNotifications({
      serviceWorker: {
        pushManager: { getSubscription }
      } as unknown as ServiceWorkerRegistration,
      criteria: ["task.private"]
    })).rejects.toMatchObject({ code: "notification_criterion_not_declared" });
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
        body: "Open TaskNotes to review it.",
        tag: "task-ready"
      }
    };

    expect(parseMdbasePushPayload(payload)).toEqual(payload);
    await showMdbasePushNotification({ showNotification }, payload);
    expect(showNotification).toHaveBeenCalledWith("A task is ready", {
      body: "Open TaskNotes to review it.",
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
});

describe("long mutation progress", () => {
  const renameInput = {
    from: "Notes/source.md",
    to: "Archive/source.md",
    update_refs: true,
    if_revision: "sha256:source"
  };
  const renamePreview = {
    from: renameInput.from,
    to: renameInput.to,
    dry_run: true as const,
    would_rename: true as const,
    references_affected: [
      { path: "Notes/one.md", location: "body" },
      { path: "Notes/one.md", field: "related" },
      { path: "Notes/two.md", location: "body" }
    ],
    warnings: [{ path: "Notes/ambiguous.md", message: "Ambiguous link" }]
  };

  it("reports authoritative phases and estimates without repeating a supplied preflight", async () => {
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage()
    });
    const preflight = vi.spyOn(connect, "preflightRename");
    vi.spyOn(connect, "rename").mockResolvedValue({
      valid: true,
      diagnostics: [],
      result: {
        from: renameInput.from,
        to: renameInput.to,
        path: renameInput.to,
        revision: "sha256:renamed",
        frontmatter: {},
        types: []
      }
    });
    const progress: Array<Record<string, unknown>> = [];

    const result = await connect.renameWithProgress(renameInput, {
      preflight: renamePreview,
      onProgress: (event) => progress.push(event as unknown as Record<string, unknown>)
    });

    expect(result.result.path).toBe(renameInput.to);
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
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage()
    });
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
    })).rejects.toMatchObject({
      code: "operation_cancelled",
      outcomeUnknown: false,
      recovery: "none"
    });

    expect(rename).not.toHaveBeenCalled();
    expect(states).toEqual(["preflighting", "ready", "cancelled"]);
  });

  it("rejects a reused preflight for a different mutation", async () => {
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage()
    });
    const rename = vi.spyOn(connect, "rename");

    await expect(connect.renameWithProgress(
      { ...renameInput, to: "Archive/different.md" },
      { preflight: renamePreview }
    )).rejects.toMatchObject({ code: "invalid_preflight", recovery: "fix_request" });
    expect(rename).not.toHaveBeenCalled();
  });

  it("does not estimate reference updates for a rename-only move", async () => {
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage()
    });
    vi.spyOn(connect, "rename").mockResolvedValue({
      valid: true,
      diagnostics: [],
      result: {
        from: renameInput.from,
        to: renameInput.to,
        path: renameInput.to,
        revision: "sha256:moved",
        frontmatter: {},
        types: []
      }
    });
    const progress: Array<{ state: string; estimate?: { affectedRecords: number; totalUnits: number } }> = [];

    await connect.renameWithProgress({ ...renameInput, update_refs: false }, {
      preflight: renamePreview,
      onProgress: (event) => progress.push(event)
    });

    expect(progress.find(({ state }) => state === "ready")?.estimate).toMatchObject({
      affectedRecords: 0,
      totalUnits: 1
    });
  });
});

describe("authorization renewal", () => {
  it("coalesces concurrent authorization completion into one code exchange", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:pending:${serverUrl}:${manifestUrl}`, JSON.stringify({
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
      collection_id: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [] }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
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
    expect(first).toMatchObject({
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"]
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports capability gaps and requests only the least-privilege union", async () => {
    const storage = new MemoryStorage();
    const navigate = vi.fn();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
      accessToken: "mdb_current",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query", "read"],
      scope: { contracts: [] },
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      application: {
        id: "00000000-0000-0000-0000-000000000001",
        name: "TaskNotes",
        homepage: "https://tasks.example"
      }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "dev.tasknotes.app://auth/mdbase/callback",
      storage,
      relayEncryption: "disabled",
      navigate
    });

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

    void connect.requestOperations(["read", "update"]);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(new URL(navigate.mock.calls[0][0]).searchParams.get("operations")).toBe("query,read,update");
  });

  it("attaches the exact capability gap to insufficient-access errors", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
      accessToken: "mdb_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [] },
      expiresAt: Date.now() + 60_000
    }));
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });

    await expect(connect.read({ path: "Notes/example.md" })).rejects.toMatchObject({
      code: "insufficient_access",
      requiresAuthorization: true,
      recovery: "reauthorize",
      details: {
        requiredOperations: ["read"],
        grantedOperations: ["query"],
        missingOperations: ["read"]
      }
    });
  });

  it("uses injected navigation for native authorization", async () => {
    const storage = new MemoryStorage();
    const navigate = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      application: {
        id: "00000000-0000-0000-0000-000000000001",
        name: "TaskNotes",
        homepage: "https://tasks.example"
      }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connect = new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/.well-known/mdbase-app.json",
      redirectUri: "dev.tasknotes.app://auth/mdbase/callback",
      storage,
      relayEncryption: "disabled",
      navigate
    });

    void connect.authorize(["query"]);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(new URL(navigate.mock.calls[0][0]).searchParams.get("redirect_uri"))
      .toBe("dev.tasknotes.app://auth/mdbase/callback");
  });

  it("sends hosted operations directly to the provider with its scoped capability", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const providerUrl = "https://provider.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
      accessToken: "mdb_control",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [{ id: "tasknotes.task", version: 1 }] },
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000,
      hosted: {
        providerUrl,
        replicaId: "00000000-0000-0000-0000-000000000003",
        accessToken: "hsa_direct"
      }
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { valid: true, result: { results: [] }, diagnostics: [] }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });

    expect((await connect.query()).valid).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${providerUrl}/v1/hosted/collections/00000000-0000-0000-0000-000000000002/operations/query`
    );
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer hsa_direct");
  });

  it("keeps hosted sync credentials private and refreshes them for the offline transport", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const providerUrl = "https://provider.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
      accessToken: "mdb_control",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query", "create", "update", "delete"],
      scope: { contracts: [{ id: "tasknotes.task", version: 1 }] },
      expiresAt: Date.now() + 60_000,
      refreshExpiresAt: Date.now() + 120_000,
      hosted: {
        providerUrl,
        replicaId: "00000000-0000-0000-0000-000000000003",
        accessToken: "hsa_direct"
      }
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      protocol_version: 1,
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
    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });

    const hosted = connect.hostedSync();
    expect(hosted).toEqual(expect.objectContaining({
      collectionId: "00000000-0000-0000-0000-000000000002",
      replicaId: "00000000-0000-0000-0000-000000000003"
    }));
    expect(JSON.stringify(hosted)).not.toContain("hsa_direct");
    expect((await hosted!.transport.openSession()).mode).toBe("read_write");
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `${providerUrl}/v1/hosted/collections/00000000-0000-0000-0000-000000000002/sync/sessions`
    );
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer hsa_direct");
  });

  it("rotates an expired access token and retries with the renewed credential", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
      accessToken: "mdb_expired",
      refreshToken: "ref_current",
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [{ id: "tasknotes.task", version: 1 }] },
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
        scope: { contracts: [{ id: "tasknotes.task", version: 1 }] }
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { valid: true, result: { results: [] }, diagnostics: [] }
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });
    const result = await connect.query();

    expect(result.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${serverUrl}/oauth/token`);
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer mdb_renewed");
    expect(JSON.parse(storage.getItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`)!))
      .toEqual(expect.objectContaining({ accessToken: "mdb_renewed", refreshToken: "ref_rotated" }));
  });

  it("uses a refresh credential rotated by another browser tab", async () => {
    const storage = new MemoryStorage();
    const serverUrl = "https://connect.example";
    const manifestUrl = "https://tasks.example/.well-known/mdbase-app.json";
    const tokenKey = `mdbase-connect:token:${serverUrl}:${manifestUrl}`;
    const baseToken = {
      clientId: "00000000-0000-0000-0000-000000000001",
      collectionId: "00000000-0000-0000-0000-000000000002",
      operations: ["query"],
      scope: { contracts: [{ id: "tasknotes.task", version: 1 }] },
      refreshExpiresAt: Date.now() + 60_000
    };
    storage.setItem(tokenKey, JSON.stringify({
      ...baseToken,
      accessToken: "mdb_expired",
      refreshToken: "ref_old",
      expiresAt: Date.now() - 1
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        storage.setItem(tokenKey, JSON.stringify({
          ...baseToken,
          accessToken: "mdb_from_other_tab",
          refreshToken: "ref_from_other_tab",
          expiresAt: Date.now() + 3_600_000
        }));
        return new Response(JSON.stringify({
          error: { code: "invalid_grant", message: "Refresh token has already been used." }
        }), { status: 400, headers: { "content-type": "application/json" } });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { valid: true, result: { results: [] }, diagnostics: [] }
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const connect = new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage
    });
    const result = await connect.query();

    expect(result.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>).authorization)
      .toBe("Bearer mdb_from_other_tab");
    expect(JSON.parse(storage.getItem(tokenKey)!))
      .toEqual(expect.objectContaining({ refreshToken: "ref_from_other_tab" }));
  });
});

describe("direct loopback routing", () => {
  it("retries the exact encrypted envelope through the relay after an ambiguous direct failure", async () => {
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
      });

    await expect(fixture.connect.create({
      path: "one.md",
      frontmatter: { title: "Only once" }
    })).rejects.toEqual(expect.objectContaining({ code: "direct_outcome_unknown" }));

    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:28485/v1/operations",
      `${fixture.serverUrl}/v1/collections/${fixture.collectionId}/operations/create`
    ]);
    expect(requests[0].body).toBe(requests[1].body);
    expect(JSON.parse(requests[0].body)).toEqual(expect.objectContaining({
      type: "encrypted_operation_request",
      operation: "create",
      counter: "1"
    }));

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
    })).rejects.toEqual(expect.objectContaining({ code: "pending_mutation_unresolved" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "upgrade_required", message: "Use the relay." }
        }), { status: 426, headers: { "content-type": "application/json" } });
      })
      .mockImplementationOnce(async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({
          error: { code: "connector_offline", message: "Connector offline." }
        }), { status: 503, headers: { "content-type": "application/json" } });
      });
    await expect(fixture.connect.create({
      frontmatter: { title: "Only once" },
      path: "one.md"
    })).rejects.toEqual(expect.objectContaining({ code: "direct_outcome_unknown" }));
    expect(requests[2].body).toBe(requests[0].body);
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

    await expect(fixture.connect.operation("create", input, {
      signal: controller.signal
    })).rejects.toMatchObject({
      code: "operation_cancelled",
      outcomeUnknown: true,
      recovery: "resolve_outcome"
    });
    expect(fixture.connect.pendingMutation()).toMatchObject({
      operation: "create",
      resumable: true
    });

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

    await expect(fixture.connect.resumePendingMutation(input)).rejects.toMatchObject({
      code: "direct_outcome_unknown",
      outcomeUnknown: true
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "http://127.0.0.1:28485/v1/operations",
      "http://127.0.0.1:28485/v1/operations",
      `${fixture.serverUrl}/v1/collections/${fixture.collectionId}/operations/create`
    ]);
    expect(new Set(requests.map(({ body }) => body))).toHaveLength(1);
    expect(fixture.connect.pendingMutation()).toMatchObject({ operation: "create" });
  });

  it("does not bypass an explicit rejection from the local authorization boundary", async () => {
    const fixture = await encryptedConnection();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "direct_operation_rejected", message: "Rejected locally." }
    }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "direct_operation_rejected"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:28485/v1/operations");
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

    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "connector_offline"
    }));
    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "connector_offline"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urls).toEqual([
      "http://127.0.0.1:28485/v1/operations",
      `${fixture.serverUrl}/v1/collections/${fixture.collectionId}/operations/query`,
      `${fixture.serverUrl}/v1/collections/${fixture.collectionId}/operations/query`
    ]);
  });

  it("renews a stale binding after an uncertain direct read without reporting an unknown write", async () => {
    const fixture = await encryptedConnection();
    const token = JSON.parse(fixture.storage.getItem(
      `mdbase-connect:token:${fixture.serverUrl}:${fixture.manifestUrl}`
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

    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "connector_offline"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("checks generic readiness from a user gesture without sending ambient credentials", async () => {
    const fixture = await encryptedConnection();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      service: "mdbase-connect",
      loopback_protocol_version: 1,
      encrypted_protocol_version: 3
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const changes: string[] = [];
    fixture.connect.onConnectionChange((connection) => {
      if (connection) changes.push(connection.directAccess);
    });

    await expect(fixture.connect.requestDirectAccess()).resolves.toBe("available");
    const init = fetchMock.mock.calls[0][1] as RequestInit & { targetAddressSpace?: string };
    expect(init.credentials).toBe("omit");
    expect(init.targetAddressSpace).toBe("loopback");
    expect(changes).toContain("checking");
    expect(changes.at(-1)).toBe("available");
  });

  it("lets a user re-enable direct access after disabling it", async () => {
    const fixture = await encryptedConnection();
    fixture.connect.disableDirectAccess();
    expect(fixture.connect.connection()?.directAccess).toBe("disabled");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      service: "mdbase-connect",
      loopback_protocol_version: 1,
      encrypted_protocol_version: 3
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.requestDirectAccess()).resolves.toBe("available");
    expect(fixture.connect.connection()?.directAccess).toBe("available");
  });

  it("keeps direct grant proof usable after every cloud credential expires", async () => {
    const fixture = await encryptedConnection();
    const tokenKey = `mdbase-connect:token:${fixture.serverUrl}:${fixture.manifestUrl}`;
    const token = JSON.parse(fixture.storage.getItem(tokenKey)!);
    fixture.storage.setItem(tokenKey, JSON.stringify({
      ...token,
      expiresAt: Date.now() - 60_000,
      refreshExpiresAt: Date.now() - 30_000
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: { code: "direct_operation_rejected", message: "Reached the connector." }
    }), { status: 403, headers: { "content-type": "application/json" } }));

    await expect(fixture.connect.query()).rejects.toEqual(expect.objectContaining({
      code: "direct_operation_rejected"
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://127.0.0.1:28485/v1/operations");
    expect(fixture.storage.getItem(tokenKey)).not.toBeNull();
  });

  it("rejects loopback overrides that could escape the local machine", () => {
    expect(() => new MdbaseConnect({
      serverUrl: "https://connect.example",
      manifestUrl: "https://tasks.example/manifest.json",
      redirectUri: "https://tasks.example/callback",
      storage: new MemoryStorage(),
      loopbackUrl: "http://connector.evil.example:28485"
    })).toThrow(expect.objectContaining({ code: "invalid_loopback_url" }));
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
    protocol_version: 3,
    suite: "P256-HKDF-SHA256-AES256GCM",
    key_id: "enc_direct",
    scope_epoch: 1,
    connector_id: "01933333-3333-7333-8333-333333333333",
    collection_id: collectionId,
    application_public_key: application.publicKey,
    connector_public_key: connector.publicKey
  };
  storage.setItem(`mdbase-connect:token:${serverUrl}:${manifestUrl}`, JSON.stringify({
    accessToken: "mdb_current",
    refreshToken: "ref_current",
    clientId: "01922222-2222-7222-8222-222222222222",
    collectionId,
    operations: [
      "describe", "changes", "read", "query", "list_views", "execute_view", "validate", "create", "update", "delete", "rename",
      "read_type", "create_type", "update_type"
    ],
    scope: { contracts: [] },
    expiresAt: Date.now() + 60_000,
    refreshExpiresAt: Date.now() + 120_000,
    grantId: "01911111-1111-7111-8111-111111111111",
    encryption,
    applicationOrigin: "https://tasks.example",
    keyHandle: "grant-key"
  }));
  storage.setItem("mdbase-connect:direct:https://tasks.example", "enabled");
  return {
    serverUrl,
    manifestUrl,
    collectionId,
    storage,
    connect: new MdbaseConnect({
      serverUrl,
      manifestUrl,
      redirectUri: "https://tasks.example/callback",
      storage,
      keyStore
    })
  };
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
