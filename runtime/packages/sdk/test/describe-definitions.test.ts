import { describe, expect, it } from "vitest";
import { connect, isMdbaseError, type Connector, type FramePort } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame, describeResult } from "../src/wire.js";

const app = { name: "describe-definitions-test", version: "0.0.0" };
const TYPE = '---\nkind: "mdbase.type"\nname: "note"\nversion: 2\nschema: {"dialect":"json-schema-2020-12","value":{"type":"object"}}\n---\n';

function seeded() {
  const replica = new MemoryReplica({});
  replica.seedResource("_types/note.md", TYPE);
  return replica;
}

/** A producer from before rich describe: it ignores the param and omits the new keys. */
function olderProducer(replica: MemoryReplica): Connector {
  const base = replica.connector();
  return {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const describes = new Set<number>();
      const port: FramePort = {
        onframe: null, onclose: null,
        close: () => opened.port.close(),
        send(frame) {
          const f = clientFrame.dec(frame);
          if (f.kind === "request" && f.method === "describe") describes.add(f.id);
          opened.port.send(frame);
        },
      };
      opened.port.onframe = (frame) => {
        const f = clientFrame.dec(frame);
        if (f.kind !== "response" || !describes.has(f.id) || f.result === undefined) return port.onframe?.(frame);
        const d = describeResult.dec(f.result);
        f.result = describeResult.enc({ ...d, types: d.types.map(({ name, path, implements: i }) => ({ name, path, implements: i })) });
        port.onframe?.(clientFrame.enc(f));
      };
      opened.port.onclose = (error) => port.onclose?.(error);
      return { ...opened, port };
    },
  };
}

describe("describe", () => {
  it("summarises each type's version and current source revision", async () => {
    const client = await connect({ connector: seeded().connector(), app });
    const [note] = (await client.describe()).types;
    expect(note).toMatchObject({ name: "note", version: 2, revision: (await client.resources.get("_types/note.md")).revision });
    expect(note!.definition).toBeUndefined();
    client.close();
  });

  it("carries definitions and schemas when asked", async () => {
    const client = await connect({ connector: seeded().connector(), app });
    const [note] = (await client.describe({ definitions: true })).types;
    expect((note!.definition as Map<string, unknown>).get("name")).toBe("note");
    expect(note!.schema).toBeDefined();
    client.close();
  });

  it("refuses to report missing definitions as absent on an older producer", async () => {
    const client = await connect({ connector: olderProducer(seeded()), app });
    const error = await client.describe({ definitions: true }).catch((e: unknown) => e);
    expect(isMdbaseError(error) && error.code).toBe("upgrade_required");
    expect((await client.describe()).types[0]!.revision).toBeUndefined();
    client.close();
  });
});
