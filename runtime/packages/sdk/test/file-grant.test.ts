import { describe, expect, it } from "vitest";
import { connect, fileGrant, type Connector } from "../src/index.js";
import { MemoryReplica, type MemoryReplicaOptions } from "../src/testing/index.js";
import { clientFrame, helloResult, type HelloResult } from "../src/wire.js";

const app = { name: "file-grant-test", version: "0.0.0" };
const GRANT = "0190a000-0000-7000-8000-000000000001";

async function grantOf(options: MemoryReplicaOptions) {
  const client = await connect({ connector: new MemoryReplica(options).connector(), app });
  try {
    return client.files.grant;
  } finally {
    client.close();
  }
}

/** A producer from before API 1.2: same grant, negotiated at an older minor. */
function olderProducer(replica: MemoryReplica, minor: number): Connector {
  const base = replica.connector();
  return {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const frame = clientFrame.dec(opened.helloResponse);
      if (frame.kind !== "response" || frame.result === undefined) throw new Error("test hello missing");
      const result: HelloResult = helloResult.dec(frame.result);
      delete result.grant.fileFolders;
      frame.result = helloResult.enc({ ...result, version: { major: 1, minor } });
      return { ...opened, helloResponse: clientFrame.enc(frame) };
    },
  };
}

describe("file grant", () => {
  it("maps native capability groups to file actions over the whole namespace", async () => {
    expect(await grantOf({})).toEqual({
      actions: ["list", "read", "add", "replace", "move", "delete"],
      scope: { kind: "collection" },
    });
  });

  it("reports the folder scope and only the actions the grant holds", async () => {
    expect(await grantOf({ grant: GRANT, role: "editor", capabilities: ["collection.read", "records.create"], fileFolders: ["Photos"] }))
      .toEqual({ actions: ["list", "read", "add"], scope: { kind: "selected_folders", folders: ["Photos"] } });
  });

  it("never treats a non-native capability or a viewer's write capability as a file action", async () => {
    expect((await grantOf({ grant: GRANT, role: "editor", capabilities: ["collection.read", "files.write"] }))?.actions)
      .toEqual(["list", "read"]);
    expect((await grantOf({ grant: GRANT, role: "viewer", capabilities: ["collection.read", "records.create"] }))?.actions)
      .toEqual(["list", "read"]);
  });

  it("is unknown for a grant session on a producer that predates folder scope", async () => {
    const scoped = await connect({ connector: olderProducer(new MemoryReplica({ grant: GRANT, fileFolders: ["Photos"] }), 1), app });
    expect(scoped.files.grant).toBeNull();
    expect(fileGrant(scoped.hello)).toBeNull();
    scoped.close();
    // The hosting app's own session has no grant and so no folder scope.
    const host = await connect({ connector: olderProducer(new MemoryReplica({}), 1), app });
    expect(host.files.grant?.scope).toEqual({ kind: "collection" });
    host.close();
  });
});
