import { describe, expect, it } from "vitest";
import { connect, isMdbaseError, MdbaseError } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";

const app = { name: "create-type-test", version: "0.0.0" };
const type = (name: string) => `---\nkind: "mdbase.type"\nname: "${name}"\n---\n`;

async function failure(p: Promise<unknown>): Promise<MdbaseError> {
  const e = await p.then(() => undefined, (e: unknown) => e);
  if (isMdbaseError(e)) return e;
  throw new Error(`expected an mdbase error, got ${String(e)}`);
}

describe("createType", () => {
  it("writes the document at the path the replica derives, create-only", async () => {
    const client = await connect({ connector: new MemoryReplica({}).connector(), app });
    const created = await client.createType(type("note"));
    expect({ name: created.name, path: created.path }).toEqual({ name: "note", path: "_types/note.md" });
    expect((await client.resources.get(created.path)).text).toBe(type("note"));
    expect(created.write.mutationId).toBeDefined();
    client.close();
  });

  it("reports the replica's refusal and writes nothing", async () => {
    const client = await connect({ connector: new MemoryReplica({}).connector(), app });
    await client.createType(type("note"));
    const taken = await failure(client.createType(type("Note")));
    expect([taken.code, taken.reason]).toEqual(["conflict", "type_conflict"]);
    const nameless = await failure(client.createType('---\nkind: "mdbase.type"\n---\n'));
    expect([nameless.code, nameless.reason]).toEqual(["invalid_record", "invalid_type_definition"]);
    expect((await client.resources.list()).resources.map(r => r.path)).toEqual(["_types/note.md"]);
    client.close();
  });
});
