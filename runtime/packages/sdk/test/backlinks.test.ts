import { describe, expect, it } from "vitest";
import { connect, isMdbaseError, mdbaseError, type Connector } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame } from "../src/wire.js";

const app = { name: "backlinks-test", version: "0.0.0" };

/** A replica that predates `backlinks` (replica-client-api.md §4.2). */
function withoutBacklinks(replica: MemoryReplica): Connector {
  const base = replica.connector();
  return {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const port = opened.port;
      const send = port.send.bind(port);
      port.send = (frame) => {
        const f = clientFrame.dec(frame);
        if (f.kind === "request" && f.method === "backlinks") {
          const problem = mdbaseError("invalid_request", "unknown method backlinks", "unknown_method").toProblem();
          queueMicrotask(() => port.onframe?.(clientFrame.enc({ kind: "response", id: f.id, problem })));
          return;
        }
        send(frame);
      };
      return opened;
    },
  };
}

describe("backlinks", () => {
  it("returns each referring record with its links to the target", async () => {
    const client = await connect({ connector: new MemoryReplica({}).connector(), app });
    const target = await client.create({ path: "notes/target.md", body: "Self: [[target]]" });
    await client.create({ path: "b.md", body: "See [[target]] and ![[target]]." });
    await client.create({ path: "a.md", body: "Nothing here." });
    const page = await client.backlinks(target.recordId);
    expect(page.backlinks.map(b => b.record.path)).toEqual(["b.md"]);
    expect(page.backlinks[0]!.links.map(l => [l.raw, l.embed, l.resolution.target])).toEqual([
      ["[[target]]", false, target.recordId],
      ["![[target]]", true, target.recordId],
    ]);
    expect(page.cursor).toBeUndefined();
    client.close();
  });

  it("is refused as an update by a replica without the method", async () => {
    const client = await connect({ connector: withoutBacklinks(new MemoryReplica({})), app });
    const e = await client.backlinks({ path: "notes/target.md" }).catch((e: unknown) => e);
    expect(isMdbaseError(e) && [e.code, e.reason]).toEqual(["upgrade_required", "backlinks_unsupported"]);
    client.close();
  });
});
