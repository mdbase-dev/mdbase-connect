import { describe, expect, it } from "vitest";
import type { CborValue } from "../src/cbor.js";
import { connect, isMdbaseError, type Connector } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame } from "../src/wire.js";

const app = { name: "contract-records-test", version: "0.0.0" };
const contract = { id: "acme.card", version: "1.0.0" };
const digest = new Uint8Array(32).fill(7);
const uuidBytes = (id: string) => Uint8Array.from(id.replace(/-/g, "").match(/../g)!.map(h => parseInt(h, 16)));

/** A MemoryReplica whose Core-side contract methods answer from `answer`. */
function withContractMethods(replica: MemoryReplica, answer: (method: string, params: Map<number, CborValue>) => CborValue) {
  const base = replica.connector();
  const seen: Array<[string, Map<number, CborValue>]> = [];
  const connector: Connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const port = opened.port;
      const send = port.send.bind(port);
      port.send = (frame) => {
        const f = clientFrame.dec(frame);
        if (f.kind === "request" && f.method.startsWith("map_contract_write") || f.kind === "request" && f.method.startsWith("get_contract")) {
          const p = f.params as Map<number, CborValue>;
          seen.push([f.method, p]);
          queueMicrotask(() => port.onframe?.(clientFrame.enc({ kind: "response", id: f.id, result: answer(f.method, p) })));
          return;
        }
        send(frame);
      };
      return opened;
    },
  };
  return { connector, seen };
}

function plan(patch: Map<string, CborValue>, record?: { id: string; path: string }): CborValue {
  const m = new Map<number, CborValue>([[0, 1], [1, "card"], [2, patch], [3, []], [4, []], [5, digest], [6, digest]]);
  if (record) { m.set(7, uuidBytes(record.id)); m.set(8, record.path); m.set(9, digest); }
  return m;
}

describe("contract-scoped records", () => {
  it("submits the replica's mapping as ordinary record writes", async () => {
    const replica = new MemoryReplica({});
    let target: { id: string; path: string } | undefined;
    const { connector, seen } = withContractMethods(replica, (method, p) => {
      if (method === "get_contract_v1") {
        return new Map<number, CborValue>([[0, 1], [1, uuidBytes(target!.id)], [2, target!.path], [3, digest], [4, "card"], [5, new Map([["name", "A"]])], [6, digest], [7, digest]]);
      }
      return p.has(4) ? plan(new Map([["label", "B"]]), target) : plan(new Map([["label", "A"]]));
    });
    const client = await connect({ connector, app });
    const created = await client.create({ path: "cards/a.md", contract, frontmatter: { name: "A" } });
    const a = await client.get({ path: "cards/a.md" });
    target = { id: a.id, path: a.path };
    expect(a.frontmatter.get("label")).toBe("A");
    expect(created.mutationId).toBeDefined();
    expect(seen[0]![1].get(5)).toEqual(new Map([["name", "A"]]));

    const view = await client.getContract({ path: "cards/a.md" }, contract);
    expect(view).toMatchObject({ id: a.id, path: "cards/a.md", fields: new Map([["name", "A"]]), contract: { ...contract, type: "card" } });

    await client.update(view, { contract, patch: { name: "B" } });
    expect((await client.get(a.id)).frontmatter.get("label")).toBe("B");
    await client.rename(view, "cards/b.md", { contract });
    expect((await client.get(a.id)).path).toBe("cards/b.md");
    target = { id: a.id, path: "cards/b.md" };
    expect(seen.map(([m, p]) => [m, p.get(m === "get_contract_v1" ? 1 : 4) !== undefined])).toEqual([
      ["map_contract_write_v1", false], ["get_contract_v1", true], ["map_contract_write_v1", true], ["map_contract_write_v1", true],
    ]);
    client.close();
  });

  it("updates contract fields and the body in one write on the testing replica", async () => {
    const replica = new MemoryReplica({
      confirmDelayMs: null,
      contracts: [{ ...contract, type: "card", fields: { name: "title", label: "/meta/label" } }],
    });
    const client = await connect({ connector: replica.connector(), app });
    await client.create({ path: "cards/a.md", contract, frontmatter: { name: "A", label: "x" }, body: "draft" });
    const view = await client.getContract({ path: "cards/a.md" }, contract);
    expect(view.fields).toEqual(new Map([["name", "A"], ["label", "x"]]));
    expect(view.contract.type).toBe("card");

    const w = await client.update(view, { contract, patch: { label: "y" }, body: "final" });
    const record = await client.get(view.id, { body: true });
    expect(record.frontmatter.get("meta")).toEqual(new Map([["label", "y"]]));
    expect(record.body).toBe("final");
    expect(w.mutationId).toBeDefined();
    const unmapped = await client.update(view, { contract, patch: { other: 1 } }).catch((e: unknown) => e);
    expect(isMdbaseError(unmapped) && unmapped.reason).toBe("data_contract_field_unmapped");
    client.close();
  });

  it("promotes an untyped record in one write, keeping its ID, body and fields", async () => {
    const replica = new MemoryReplica({
      confirmDelayMs: null,
      contracts: [{ ...contract, type: "card", fields: { name: "title" }, contractDigest: `sha256:${"ab".repeat(32)}` }],
    });
    const client = await connect({ connector: replica.connector(), app });
    await client.create({ path: "drafts/m.md", frontmatter: { custom: 1 }, body: "text" });
    const draft = await client.get({ path: "drafts/m.md" }, { body: true });
    const refused = await client.update(draft, { contract, patch: { name: "M" } }).catch((e: unknown) => e);
    expect(isMdbaseError(refused) && refused.reason).toBe("data_contract_not_implemented");

    await client.update(draft, { contract, promote: true, patch: { name: "M" }, ifRevision: draft.revision });
    const promoted = await client.get(draft.id, { body: true });
    expect([promoted.id, promoted.body, promoted.types]).toEqual([draft.id, "text", ["card"]]);
    expect(promoted.frontmatter).toEqual(new Map<string, unknown>([["custom", 1], ["title", "M"], ["type", "card"]]));
    const view = await client.getContract(draft.id, contract);
    expect([view.fields.get("name"), view.contract.digest]).toEqual(["M", `sha256:${"ab".repeat(32)}`]);
    client.close();
  });

  it("is refused by a replica without contract-scoped records", async () => {
    const client = await connect({ connector: new MemoryReplica({}).connector(), app });
    const e = await client.getContract({ path: "a.md" }, contract).catch((e: unknown) => e);
    expect(isMdbaseError(e) && [e.code, e.reason]).toEqual(["upgrade_required", "contract_records_unsupported"]);
    client.close();
  });
});
