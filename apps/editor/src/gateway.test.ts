import { describe, expect, it, vi } from "vitest";
import {
  MdbaseBrowserLocation,
  MdbaseCollectionClient,
  MdbaseConnectError,
  MdbaseOperationValidationError,
  type DirectAccessStatus,
  type MdbaseConnect
} from "@mdbase/connect";
import { ConnectCollectionGateway, gatewayError } from "./gateway";
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

    const structure = await gateway.list((update) => structureProgress.push(update));

    expect(query.mock.calls.map(([input]) => [input.include_body, input.offset])).toEqual([
      [false, 0],
      [false, 1]
    ]);
    expect(structureProgress[0]).toMatchObject({ structureComplete: false, complete: false, contentComplete: false, total: 2 });
    expect(structureProgress[1]).toMatchObject({ structureComplete: true, complete: true, contentComplete: false, total: 2 });
    expect(structure.map((note) => note.path)).toEqual(["Notes/one.md", "Archive/two.md"]);
    expect(structure.every((note) => note.body === undefined)).toBe(true);

    const notes = await gateway.hydrateContent((update) => contentProgress.push(update));

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
    expect(notes.map((note) => note.body)).toEqual(["Body 1", "Body 2"]);
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

  it("carries a deep-linked collection into first-time authorization", async () => {
    const originalLocation = `${location.pathname}${location.search}${location.hash}`;
    history.replaceState(null, "", "/?collection=deep-linked-collection");
    const authorize = vi.fn(async () => undefined);
    const manager = {
      authorize,
      connections: () => [],
      connection: () => undefined,
      onConnectionsChange: () => () => undefined
    } as unknown as MdbaseConnect;
    const gateway = new ConnectCollectionGateway("https://connect.example");
    Object.defineProperty(gateway, "manager", { value: manager });
    Object.defineProperty(gateway, "browserLocation", {
      value: new MdbaseBrowserLocation(manager)
    });

    await gateway.authorize();

    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      collectionId: "deep-linked-collection",
      returnTo: "/?collection=deep-linked-collection"
    }));
    gateway.selectConnection("saved-collection");
    expect(gateway.authorizationTarget()).toBeNull();
    history.replaceState(null, "", originalLocation);
  });

  it("turns stale connector grants into a clear authorization action", () => {
    expect(gatewayError(new MdbaseConnectError(
      "direct_operation_rejected",
      "The local connector rejected this operation.",
      { status: 403 }
    ))).toBe("This collection needs authorization again. Choose the collection to continue.");
  });

  it("uses SDK capability gaps and envelope validation", async () => {
    const requestOperations = vi.fn(async () => undefined);
    const read = vi.fn(async () => ({
      valid: false,
      diagnostics: [{ severity: "error", code: "invalid_record", message: "The note is invalid." }],
      result: { path: "Notes/invalid.md", frontmatter: {}, types: [], revision: "invalid" }
    }));
    const gateway = new ConnectCollectionGateway("https://connect.example");
    injectConnection(gateway, {
      collectionId: "collection",
      displayName: "Notes",
      operations: ["read"],
      authorizationCapabilities: () => ({ missingOperations: ["update"] }),
      requestOperations,
      read
    });

    expect(gateway.connection()).toEqual({
      collectionId: "collection",
      displayName: "Notes",
      operations: ["read"],
      missingOperations: ["update"],
      route: "relay",
      directAccess: "unavailable"
    });
    await gateway.authorize();
    expect(requestOperations).toHaveBeenCalledWith(
      expect.arrayContaining(["describe", "read", "update", "rename"]),
      expect.objectContaining({ returnTo: expect.any(String) })
    );
    await expect(gateway.read("Notes/invalid.md")).rejects.toBeInstanceOf(MdbaseOperationValidationError);
    await expect(gateway.read("Notes/invalid.md")).rejects.toMatchObject({
      diagnostics: [{ code: "invalid_record" }],
      result: { path: "Notes/invalid.md" }
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
): void {
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
  const manager = {
    connections: () => [{
      collectionId: bound.collectionId,
      displayName: bound.displayName,
      operations: bound.operations
    }],
    connection: () => bound,
    onConnectionsChange: () => () => undefined
  } as unknown as MdbaseConnect;
  Object.defineProperty(gateway, "manager", { value: manager });
  Object.defineProperty(gateway, "browserLocation", {
    value: new MdbaseBrowserLocation(manager)
  });
}
