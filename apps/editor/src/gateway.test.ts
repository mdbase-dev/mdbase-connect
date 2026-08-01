import { describe, expect, it, vi } from "vitest";
import {
  MdbaseBrowserSelection,
  MdbaseCollectionClient,
  ConnectOutcomeError,
  connectFailure,
  connectProblem,
  connectSuccess,
  MdbaseSession,
  type DirectAccessStatus,
  type MdbaseConnection,
  type MdbaseConnectionInfo,
  type MdbaseSessionSnapshot
} from "@mdbase-dev/connect";
import { ConnectCollectionGateway, FULL_COLLECTION_OPERATIONS, gatewayError } from "./gateway";
import type { NoteDocument, NoteListProgress, NoteSummary } from "./model";

describe("ConnectCollectionGateway collection index", () => {
  it("loads the complete structure before hydrating note bodies on demand", async () => {
    const metadata = [summary("Notes/one.md"), summary("Archive/two.md")];
    const hydrated = metadata.map((note, index) => ({ ...note, body: `Body ${index + 1}` }));
    const query = vi.fn(async ({ include_body: includeBody, offset }: { include_body: boolean; offset: number; snapshot?: string }) => {
      const page = includeBody ? hydrated[offset] : metadata[offset];
      return {
        valid: true,
        diagnostics: [],
        result: {
          results: page ? [page] : [],
          meta: { total_count: 2, has_more: offset === 0, snapshot: "stable-index" }
        }
      };
    });
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectConnection(gateway, new MdbaseCollectionClient({
        async operation<Result>(_operation: string, input: unknown) {
          return await query(input as { include_body: boolean; offset: number; snapshot?: string }) as Result;
        }
      }));
    const structureProgress: NoteListProgress[] = [];
    const contentProgress: NoteListProgress[] = [];

    const structure = await gateway.list({ onProgress: (update) => { structureProgress.push(update); } });

    expect(query.mock.calls.map(([input]) => [input.include_body, input.offset])).toEqual([
      [false, 0],
      [false, 1]
    ]);
    expect(structureProgress[0]).toMatchObject({ structureComplete: false, complete: false, contentComplete: false, total: 2 });
    expect(structureProgress[1]).toMatchObject({ structureComplete: true, complete: true, contentComplete: false, total: 2 });
    expect(structure.notes.map((note) => note.path)).toEqual(["Notes/one.md", "Archive/two.md"]);
    expect(structure.notes.every((note) => note.body === undefined)).toBe(true);

    const notes = await gateway.hydrateContent({
      snapshot: structure.snapshot,
      onProgress: (update) => { contentProgress.push(update); }
    });

    expect(query.mock.calls.map(([input]) => [input.include_body, input.offset])).toEqual([
      [false, 0],
      [false, 1],
      [true, 0],
      [true, 1]
    ]);
    expect(query.mock.calls.map(([input]) => input.snapshot)).toEqual([
      undefined,
      "stable-index",
      "stable-index",
      "stable-index"
    ]);
    expect(contentProgress[0]).toMatchObject({ structureComplete: true, complete: false, contentComplete: false, contentLoaded: 1, total: 2 });
    expect(contentProgress.at(-1)).toMatchObject({ structureComplete: true, complete: true, contentComplete: true, contentLoaded: 2, total: 2 });
    expect(notes.notes.map((note) => note.body)).toEqual(["Body 1", "Body 2"]);
  });
});

describe("ConnectCollectionGateway recovery operations", () => {
  it("checks and requests direct access through the active SDK connection", async () => {
    let directAccess: DirectAccessStatus = "permission_required";
    const checkDirectAccess = vi.fn(async () => "permission_required" as const);
    const requestDirectAccess = vi.fn(async () => {
      directAccess = "available";
      return directAccess;
    });
    const connection = {
      route: "relay" as const,
      get directAccess() { return directAccess; },
      checkDirectAccess,
      requestDirectAccess
    };
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectConnection(gateway, connection);

    await expect(gateway.checkDirectAccess()).resolves.toMatchObject({
      route: "relay",
      directAccess: "permission_required"
    });
    await expect(gateway.requestDirectAccess()).resolves.toMatchObject({
      route: "relay",
      directAccess: "available"
    });
    expect(checkDirectAccess).toHaveBeenCalledOnce();
    expect(requestDirectAccess).toHaveBeenCalledOnce();
  });

  it("keeps a deep-linked unavailable collection as the exact authorization target", async () => {
    const originalLocation = `${location.pathname}${location.search}${location.hash}`;
    history.replaceState(null, "", "/?collection=deep-linked-collection");
    const authorize = vi.fn(async () => undefined);
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectSession(gateway, {
      getSnapshot: () => ({
        status: "unavailable",
        collectionId: "deep-linked-collection",
        reason: "not_authorized",
        connections: []
      }),
      authorize
    });

    await gateway.authorize("selected");

    expect(gateway.sessionSnapshot()).toEqual({
      status: "unavailable",
      collectionId: "deep-linked-collection",
      reason: "not_authorized",
      connections: []
    });
    expect(authorize).toHaveBeenCalledWith("selected");
    history.replaceState(null, "", originalLocation);
  });

  it("replaces a stale browser bookmark when opening a saved collection without reloading", async () => {
    const originalLocation = `${location.pathname}${location.search}${location.hash}`;
    history.replaceState(null, "", "/?collection=stale-collection");
    const saved = sessionConnection("saved-collection", "Saved notes");
    const connect = {
      connections: () => [saved.info()],
      connection: (collectionId: string) => collectionId === saved.collectionId ? saved : null,
      unavailableReason: () => null,
      onConnectionsChange: () => () => undefined
    };
    const session = new MdbaseSession(connect as never, {
      operations: FULL_COLLECTION_OPERATIONS,
      selection: new MdbaseBrowserSelection(),
      autoSelect: "never"
    });

    await session.start();
    expect(session.getSnapshot()).toMatchObject({
      status: "unavailable",
      collectionId: "stale-collection"
    });

    const selected = session.select("saved-collection", { history: "replace" });

    expect(selected).toMatchObject({ ok: true, value: saved });
    expect(session.getSnapshot()).toMatchObject({
      status: "ready",
      collectionId: "saved-collection"
    });
    expect(new URL(location.href).searchParams.get("collection")).toBe("saved-collection");
    history.replaceState(null, "", originalLocation);
  });

  it("turns stale connector grants into a clear authorization action", () => {
    expect(gatewayError(new ConnectOutcomeError(connectProblem(
      "direct_operation_rejected",
      "The local connector rejected this operation."
    )))).toBe("This collection needs authorization again. Choose the collection to continue.");
  });

  it("uses SDK capability gaps and envelope validation", async () => {
    const read = vi.fn(async () => ({
      valid: false,
      diagnostics: [{ severity: "error", code: "invalid_record", message: "The note is invalid." }],
      result: { path: "Notes/invalid.md", frontmatter: {}, types: [], revision: "invalid" }
    }));
    const gateway = new ConnectCollectionGateway("https://connect.example");
    const session = injectConnection(gateway, {
      collectionId: "collection",
      displayName: "Notes",
      operations: ["read"],
      authorizationCapabilities: () => ({ missingOperations: ["update"] }),
      read
    });

    expect(gateway.sessionSnapshot()).toEqual({
      status: "ready",
      connections: [expect.objectContaining({ collectionId: "collection" })],
      connection: {
      collectionId: "collection",
      displayName: "Notes",
      operations: ["read"],
      missingOperations: ["update"],
      route: "relay",
      directAccess: "unavailable"
      }
    });
    await gateway.authorize("selected");
    expect(session.authorize).toHaveBeenCalledWith("selected");
    await expect(gateway.read("Notes/invalid.md")).rejects.toBeInstanceOf(ConnectOutcomeError);
    await expect(gateway.read("Notes/invalid.md")).rejects.toMatchObject({
      problem: {
        details: {
          diagnostics: [{ code: "invalid_record" }],
          partial_result: { path: "Notes/invalid.md" }
        }
      }
    });
  });

  it("restores exact Markdown content and lets callers opt out of backlink updates", async () => {
    const document: NoteDocument = {
      path: "Notes/restored.md",
      frontmatter: { title: "Original title", custom: true },
      effective_frontmatter: { title: "Resolved title", custom: true },
      body: "# Restored\n\nExact body.\n",
      types: ["note"],
      revision: "before-delete",
      file: { name: "restored.md", folder: "Notes", size: 0, mtime: "" }
    };
    const create = vi.fn(async () => ({ valid: true, diagnostics: [], result: document }));
    const renameWithProgress = vi.fn(async () => ({ valid: true, diagnostics: [], result: { ...document, from: document.path, to: "Archive/restored.md", path: "Archive/restored.md" } }));
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectConnection(gateway, { create, renameWithProgress });

    await gateway.restore(document);
    await gateway.rename(document.path, "Archive/restored.md", document.revision, false);

    expect(create).toHaveBeenCalledWith({
      path: document.path,
      frontmatter: document.frontmatter,
      body: document.body,
      include_document: true
    });
    expect(renameWithProgress).toHaveBeenCalledWith({
      from: document.path,
      to: "Archive/restored.md",
      if_revision: document.revision,
      update_refs: false,
      include_document: true
    }, {});
  });

  it("includes a local body draft in the initial create operation", async () => {
    const document: NoteDocument = {
      path: "Notes/drafted.md",
      frontmatter: { title: "Drafted" },
      effective_frontmatter: { title: "Drafted" },
      body: "Written before creation.",
      types: ["note"],
      revision: "created",
      file: { name: "drafted.md", folder: "Notes", size: 0, mtime: "" }
    };
    const create = vi.fn(async () => ({ valid: true, diagnostics: [], result: document }));
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectConnection(gateway, { create });

    await gateway.create({
      title: "Drafted",
      body: "Written before creation.",
      path: document.path,
      type: "note",
      titleField: "title",
      properties: { title: "Drafted" }
    });
    await gateway.create({
      title: "Heading note",
      body: "Also written before creation.",
      path: "Heading note.md",
      properties: {}
    });

    expect(create).toHaveBeenNthCalledWith(1, {
      path: document.path,
      type: "note",
      frontmatter: { title: "Drafted" },
      body: "Written before creation.",
      include_document: true
    });
    expect(create).toHaveBeenNthCalledWith(2, {
      path: "Heading note.md",
      frontmatter: {},
      body: "# Heading note\n\nAlso written before creation.",
      include_document: true
    });
  });

  it("updates a nested display field without replacing its sibling properties", async () => {
    const document: NoteDocument = {
      path: "People/ada.md",
      frontmatter: {
        profile: { display_name: "Augusta Ada King", timezone: "Europe/London" }
      },
      effective_frontmatter: {
        profile: { display_name: "Augusta Ada King", timezone: "Europe/London" }
      },
      body: "",
      types: ["contact"],
      revision: "revision:2",
      file: { name: "ada.md", folder: "People", size: 0, mtime: "" }
    };
    const update = vi.fn(async () => ({ valid: true, diagnostics: [], result: document }));
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectConnection(gateway, { update });

    await gateway.update({
      path: "People/ada.md",
      title: "Augusta Ada King",
      body: "",
      source: { kind: "frontmatter", field: "/profile/display_name" },
      revision: "revision:1",
      frontmatter: {
        profile: { display_name: "Ada Lovelace", timezone: "Europe/London" },
        kind: "individual"
      }
    });

    expect(update).toHaveBeenCalledWith({
      path: "People/ada.md",
      patch: {
        profile: { display_name: "Augusta Ada King", timezone: "Europe/London" }
      },
      body: "",
      if_revision: "revision:1",
      include_document: true
    });
  });

  it("installs a complete type pack through one collection operation", async () => {
    const installTypePack = vi.fn(async () => ({
      valid: true,
      diagnostics: [],
      result: {
        id: "example.contacts",
        version: "1.0.0",
        resources: [{
          target: "_types/contact.md",
          action: "create",
          digest: `sha256:${"1".repeat(64)}`
        }],
        cleanup_deferred: false
      }
    }));
    const provision = {
      manifest: {
        kind: "mdbase.type-pack" as const,
        id: "example.contacts",
        version: "1.0.0",
        resources: [{
          kind: "type" as const,
          source: "types/contact.md",
          target: "_types/contact.md",
          digest: `sha256:${"1".repeat(64)}`
        }]
      },
      resources: [{
        source: "types/contact.md",
        document: "---\nkind: mdbase.type\nname: contact\n---\n"
      }],
      provides: []
    };
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectConnection(gateway, { installTypePack });

    await expect(gateway.installTypePack(provision)).resolves.toMatchObject({
      id: "example.contacts",
      resources: [{ target: "_types/contact.md", action: "create" }]
    });
    expect(installTypePack).toHaveBeenCalledWith(provision);
  });

  it("maps canonical mutation preflight impact to editor-safe paths", async () => {
    const preflightRename = vi.fn(async () => ({
      valid: true,
      diagnostics: [],
      result: {
        references_affected: [
          { path: "Notes/linking.md", location: "body" },
          { path: "Notes/linking.md", field: "related" }
        ],
        warnings: [{ path: "Notes/ambiguous.md", message: "Ambiguous link was not updated" }]
      }
    }));
    const preflightDelete = vi.fn(async () => ({
      valid: true,
      diagnostics: [],
      result: { broken_links: [{ path: "Notes/linking.md" }, { path: "Notes/linking.md" }] }
    }));
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectConnection(gateway, { preflightRename, preflightDelete });

    await expect(gateway.preflightRename("Notes/source.md", "Archive/source.md", "revision:1")).resolves.toMatchObject({
      affectedPaths: ["Notes/linking.md"],
      warnings: ["Ambiguous link was not updated"]
    });
    await expect(gateway.preflightDelete("Notes/source.md", "revision:1")).resolves.toMatchObject({
      brokenLinkPaths: ["Notes/linking.md"]
    });
    expect(preflightRename).toHaveBeenCalledWith({
      from: "Notes/source.md",
      to: "Archive/source.md",
      if_revision: "revision:1",
      update_refs: true
    });
    expect(preflightDelete).toHaveBeenCalledWith({ path: "Notes/source.md", if_revision: "revision:1" });
  });
});

function summary(path: string): NoteSummary {
  return {
    path,
    frontmatter: {},
    effective_frontmatter: {},
    types: [],
    file: {
      path,
      name: path.split("/").at(-1)!,
      folder: path.split("/").slice(0, -1).join("/"),
      size: 0,
      mtime: ""
    }
  };
}

function injectConnection(
  gateway: ConnectCollectionGateway,
  connection: object,
): { authorize: ReturnType<typeof vi.fn> } {
  const bound = connection as {
    collectionId?: string;
    displayName?: string;
    operations?: string[];
    route?: "remote" | "direct" | "relay";
    directAccess?: "disabled" | "permission_required" | "checking" | "available" | "unavailable" | "denied";
    authorizationCapabilities?: () => { missingOperations: string[] };
  };
  bound.collectionId ??= "collection";
  bound.displayName ??= "Notes";
  bound.operations ??= [];
  bound.route ??= "relay";
  bound.directAccess ??= "unavailable";
  bound.authorizationCapabilities ??= () => ({ missingOperations: [] });
  for (const name of [
    "checkDirectAccess", "requestDirectAccess", "read", "create", "update",
    "renameWithProgress", "preflightRename", "preflightDelete", "installTypePack"
  ]) {
    const original = (bound as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    (bound as Record<string, unknown>)[name] = async (...args: unknown[]) =>
      legacyOutcome(await original.apply(bound, args));
  }
  const authorize = vi.fn(async () => connectSuccess({ kind: "redirecting" as const }));
  injectSession(gateway, {
    getSnapshot: () => {
      const info = {
        collectionId: bound.collectionId!,
        displayName: bound.displayName!,
        operations: bound.operations!,
        scope: {} as never,
        route: bound.route!,
        directAccess: bound.directAccess!
      };
      return {
        status: "ready",
        collectionId: bound.collectionId!,
        connection: bound,
        info,
        access: {
          authorized: true,
          sufficient: false,
          collectionId: bound.collectionId!,
          grantedOperations: bound.operations!,
          missingOperations: bound.authorizationCapabilities!().missingOperations
        },
        connections: [info]
      } as unknown as MdbaseSessionSnapshot;
    },
    authorize
  });
  return { authorize };
}

function injectSession(
  gateway: ConnectCollectionGateway,
  session: {
    getSnapshot: () => MdbaseSessionSnapshot;
    authorize?: (...args: unknown[]) => unknown;
    start?: () => Promise<unknown>;
    subscribe?: (listener: () => void) => () => void;
    select?: (collectionId: string) => unknown;
    forget?: (collectionId: string) => void;
  }
): void {
  Object.defineProperty(gateway, "session", {
    value: {
      start: async () => legacyOutcome(await (session.start?.() ?? session.getSnapshot())),
      subscribe: session.subscribe ?? (() => () => undefined),
      select: (collectionId: string) => legacyOutcome(session.select?.(collectionId) ?? (() => {
        const snapshot = session.getSnapshot();
        if (snapshot.status !== "ready") throw new Error("No selected connection.");
        return snapshot.connection;
      })()),
      authorize: async (target: unknown) => legacyOutcome(await (session.authorize?.(target) ?? { kind: "redirecting" as const })),
      forget: session.forget ?? vi.fn(),
      getSnapshot: session.getSnapshot
    }
  });
}

function legacyOutcome(value: unknown) {
  if (value && typeof value === "object" && "ok" in value) return value;
  if (value && typeof value === "object" && "valid" in value && "diagnostics" in value && "result" in value) {
    const envelope = value as { valid: boolean; diagnostics: import("@mdbase-dev/connect").MdbaseDiagnostic[]; result: unknown };
    if (!envelope.valid) {
      return connectFailure(connectProblem("operation_invalid", "The operation result is invalid.", {
        operationOutcome: "rejected",
        details: { diagnostics: envelope.diagnostics, partial_result: envelope.result }
      }));
    }
    return connectSuccess(envelope.result, envelope.diagnostics);
  }
  return connectSuccess(value);
}

function sessionConnection(collectionId: string, displayName: string): MdbaseConnection {
  const info: MdbaseConnectionInfo = {
    collectionId,
    displayName,
    operations: FULL_COLLECTION_OPERATIONS,
    scope: {} as never,
    route: "relay",
    directAccess: "unavailable"
  };
  return {
    collectionId,
    info: () => info,
    authorizationCapabilities: () => ({
      authorized: true,
      sufficient: true,
      collectionId,
      grantedOperations: FULL_COLLECTION_OPERATIONS,
      missingOperations: []
    }),
    onConnectionChange: () => () => undefined
  } as unknown as MdbaseConnection;
}
