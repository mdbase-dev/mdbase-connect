import { describe, expect, it } from "vitest";
import { connect, isMdbaseError, mdbaseError, type Connector } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame } from "../src/wire.js";

const app = { name: "resolve-links-test", version: "0.0.0" };

/** A replica that predates `resolve_links` (replica-client-api.md §4.3). */
function without(method: string, replica: MemoryReplica): Connector {
  const base = replica.connector();
  return {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const port = opened.port;
      const send = port.send.bind(port);
      port.send = (frame) => {
        const f = clientFrame.dec(frame);
        if (f.kind === "request" && f.method === method) {
          const problem = mdbaseError("invalid_request", `unknown method ${method}`, "unknown_method").toProblem();
          queueMicrotask(() => port.onframe?.(clientFrame.enc({ kind: "response", id: f.id, problem })));
          return;
        }
        send(frame);
      };
      return opened;
    },
  };
}

describe("resolveLinks", () => {
  it("resolves each occurrence where it is written, in request order", async () => {
    const client = await connect({ connector: new MemoryReplica({}).connector(), app });
    const target = await client.create({ path: "notes/target.md", body: "# Launch project" });
    const page = await client.resolveLinks("notes/new/draft.md", [
      "[[target]]",
      "[up](../target.md)",
      "[[Launch project]]",
      "plain text",
    ]);
    expect(page.resolutions).toEqual([
      { kind: "record", target: target.recordId, path: "notes/target.md" },
      { kind: "record", target: target.recordId, path: "notes/target.md" },
      { kind: "not_found" },
      { kind: "invalid" },
    ]);
    expect(page.complete).toBe(true);
    client.close();
  });

  it("is refused as an update by a replica without the method", async () => {
    const client = await connect({ connector: without("resolve_links", new MemoryReplica({})), app });
    const e = await client.resolveLinks("a.md", ["[[b]]"]).catch((e: unknown) => e);
    expect(isMdbaseError(e) && [e.code, e.reason]).toEqual(["upgrade_required", "resolve_links_unsupported"]);
    client.close();
  });
});
