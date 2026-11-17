import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode, type CborValue } from "../src/cbor.js";
import { isMdbaseError, mdbaseError } from "../src/index.js";
import { recordHistoryParams, recordVersionParams } from "../src/history.js";
import { connect, type Connector } from "../src/thin-client.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame } from "../src/wire.js";

const app = { name: "history-test", version: "0.0.0" };
const golden = (name: string) =>
  decode(new Uint8Array(readFileSync(join(import.meta.dirname, "../../../conformance/wire/client", `${name}.cbor`))));
const RECORD = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

/** A replica that answers `method` with `answer(params)`: a result, or a
 * problem to refuse with. */
function serving(answers: Record<string, (params: CborValue) => CborValue | Error>): Connector {
  const base = new MemoryReplica({}).connector();
  return {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const port = opened.port;
      const send = port.send.bind(port);
      port.send = (frame) => {
        const f = clientFrame.dec(frame);
        const answer = f.kind === "request" ? answers[f.method] : undefined;
        if (f.kind !== "request" || !answer) return send(frame);
        const out = answer(f.params);
        const reply = out instanceof Error && isMdbaseError(out)
          ? clientFrame.enc({ kind: "response", id: f.id, problem: out.toProblem() })
          : clientFrame.enc({ kind: "response", id: f.id, result: out as CborValue });
        queueMicrotask(() => port.onframe?.(reply));
      };
      return opened;
    },
  };
}

describe("client.history", () => {
  it("lists a record's versions with their authors and paging position", async () => {
    let asked: unknown;
    const client = await connect({
      connector: serving({ record_history: (p) => ((asked = recordHistoryParams.dec(p)), golden("record-history")) }),
      app,
    });
    const page = await client.history.list(RECORD, { before: 120, limit: 50 });
    expect(asked).toEqual({ record: RECORD, before: 120, limit: 50 });
    expect(page).toEqual({
      versions: [
        {
          seq: 119,
          time: 1791400060000,
          author: {
            account: "00000000-0000-0000-0000-000000000000",
            device: "2d7e9a41-6c3b-4f18-9a05-c8e1b2d3f467",
            grant: "4c18af2e-b04a-4b77-b83e-493c3695962e",
            grantAccount: RECORD,
          },
          kind: "moved",
          path: "notes/renamed.md",
          revision: `sha256:${"5a".repeat(32)}`,
          source: "api",
          deviceKind: "hosted",
          app: "dev.mdbase.editor",
        },
        {
          seq: 43,
          time: 1791400000000,
          author: { account: RECORD, device: "2d7e9a41-6c3b-4f18-9a05-c8e1b2d3f467" },
          kind: "deleted",
          path: "notes/a.md",
          source: "external",
          deviceKind: "desktop",
        },
      ],
      from: 21,
      fromTime: 1791390000000,
      next: 43,
    });
    client.close();
  });

  it("sends only the options given", async () => {
    let asked: unknown;
    const client = await connect({
      connector: serving({ record_history: (p) => ((asked = recordHistoryParams.dec(p)), golden("record-history")) }),
      app,
    });
    await client.history.list(RECORD);
    expect(asked).toEqual({ record: RECORD });
    client.close();
  });

  it("reads one version's exact document", async () => {
    let asked: unknown;
    const client = await connect({
      connector: serving({ record_version: (p) => ((asked = recordVersionParams.dec(p)), golden("record-version")) }),
      app,
    });
    const version = await client.history.version(RECORD, 119);
    expect(asked).toEqual({ record: RECORD, seq: 119 });
    expect(version).toEqual({ path: "notes/renamed.md", document: "---\ntitle: A\n---\nBody\n" });
    client.close();
  });

  it("passes the replica's refusals through", async () => {
    const refusal = mdbaseError("not_found", "no longer retained", "version_compacted");
    const client = await connect({ connector: serving({ record_version: () => refusal }), app });
    const e = await client.history.version(RECORD, 7).catch((e: unknown) => e);
    expect(isMdbaseError(e) && [e.code, e.reason]).toEqual(["not_found", "version_compacted"]);
    client.close();
  });

  it("is refused as an update by a replica without history", async () => {
    // MemoryReplica predates record history: it answers unknown_method.
    const client = await connect({ connector: new MemoryReplica({}).connector(), app });
    for (const read of [client.history.list(RECORD), client.history.version(RECORD, 1)]) {
      const e = await read.catch((e: unknown) => e);
      expect(isMdbaseError(e) && [e.code, e.reason]).toEqual(["upgrade_required", "history_unsupported"]);
    }
    client.close();
  });
});
