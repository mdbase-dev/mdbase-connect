import { describe, expect, it } from "vitest";
import type { CborValue } from "../src/cbor.js";
import { connect, isMdbaseError, type Connector } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame } from "../src/wire.js";

const app = { name: "type-packs-test", version: "0.0.0" };
const LIVE = `sha256:${"ab".repeat(32)}`;
const DIGEST = `sha256:${"cd".repeat(32)}`;
const pack = {
  manifest: { kind: "mdbase.type-pack", id: "example.notes", version: "1.0.0", resources: [] },
  resources: [{ source: "note.md", document: "---\nkind: mdbase.type\nname: note\n---\n" }],
};
const options = { installedBy: "dev.example.tests" };

const m = (o: Record<string, CborValue>) => new Map(Object.entries(o));
const receipt = m({ id: "example.notes", version: "1.0.0", digest: DIGEST, installed_by: "dev.example.tests", resources: [] });
function assessment(o: { action: string; manage?: boolean; status?: string; applicable?: boolean }): CborValue {
  const row = m({ source: "note.md", target: "_types/note.md", kind: "type", mode: "managed", action: o.action, digest: DIGEST });
  if (o.action === "conflict") { row.set("current_digest", LIVE); row.set("reason", "unmanaged target"); }
  if (o.action === "update") row.set("adopted_from_digest", LIVE);
  return m({
    status: o.status ?? (o.action === "conflict" ? "conflict" : "install"),
    applicable: o.applicable ?? o.action !== "conflict",
    definitions_manage: o.manage ?? true,
    assessment_digest: DIGEST,
    desired: receipt,
    resources: [row],
    lock: m({ target: "mdbase.lock.yaml", action: "create", digest: DIGEST }),
  });
}

/** A MemoryReplica whose native type pack planner answers from `answer`. */
function withPlanner(replica: MemoryReplica, answer: (p: Map<number, CborValue>) => CborValue) {
  const base = replica.connector();
  const seen: Map<number, CborValue>[] = [];
  const connector: Connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const port = opened.port;
      const send = port.send.bind(port);
      port.send = (frame) => {
        const f = clientFrame.dec(frame);
        if (f.kind === "request" && f.method === "plan_type_pack_v1") {
          const p = f.params as Map<number, CborValue>;
          seen.push(p);
          queueMicrotask(() => port.onframe?.(clientFrame.enc({ kind: "response", id: f.id, result: answer(p) })));
          return;
        }
        send(frame);
      };
      return opened;
    },
  };
  return { connector, seen };
}

describe("type packs", () => {
  it("reviews a conflict, adopts it and applies once; a current pack writes nothing", async () => {
    const replica = new MemoryReplica({});
    let current = false;
    const { connector, seen } = withPlanner(replica, (p) => {
      if (current) return new Map<number, CborValue>([[0, 1], [1, assessment({ action: "unchanged", status: "current" })], ...(p.has(7) ? [[2, []] as [number, CborValue]] : [])]);
      if (!p.has(3)) return new Map<number, CborValue>([[0, 1], [1, assessment({ action: "conflict" })]]);
      const out = new Map<number, CborValue>([[0, 1], [1, assessment({ action: "update" })]]);
      if (p.has(7)) out.set(2, [
        new Map<number, CborValue>([[0, "_types/note.md"], [1, pack.resources[0]!.document], [3, false]]),
        new Map<number, CborValue>([[0, "mdbase.lock.yaml"], [1, "lock\n"], [3, true]]),
      ]);
      return out;
    });
    const client = await connect({ connector, app });

    const first = await client.typePacks.plan(pack, options);
    expect(first.canApply).toBe(false);
    expect(first.refusal?.code).toBe("type_pack_conflict");
    expect(first.adoptable).toEqual({ "_types/note.md": LIVE });
    expect(first.summary.conflict).toEqual(["_types/note.md"]);
    await expect(client.typePacks.apply(first)).rejects.toSatisfy((e) => isMdbaseError(e, "conflict") && e.reason === "type_pack_conflict");
    expect(seen.some((p) => p.has(7))).toBe(false);

    const reviewed = await client.typePacks.plan(pack, { ...options, adopt: first.adoptable });
    expect(reviewed.canApply).toBe(true);
    expect(reviewed.resources[0]!.adoptedFromDigest).toBe(LIVE);
    const applied = await client.typePacks.apply(reviewed);
    // Accepted locally is not confirmed: the caller awaits the original write.
    expect(applied.outcome).toBe("pending");
    expect((await applied.write!.confirmed).state).toBe("confirmed");
    expect(seen.at(-1)!.get(3)).toEqual(new Map([["_types/note.md", LIVE]]));
    expect(seen.at(-1)!.get(7)).toBeInstanceOf(Uint8Array);
    expect(applied.write!.mutationId).toBeDefined();
    expect((await client.resources.get("mdbase.lock.yaml")).text).toBe("lock\n");

    current = true;
    const again = await client.typePacks.plan(pack, options);
    expect(again.status).toBe("current");
    expect(await client.typePacks.apply(again)).toEqual({ outcome: "already_current", receipt: again.desired });
    client.close();
  });

  it("reports a submit the replica rejects after planning as a refusal with the original mutation", async () => {
    const replica = new MemoryReplica({});
    replica.seedResource("mdbase.lock.yaml", "theirs\n");
    const { connector } = withPlanner(replica, (p) => {
      const out = new Map<number, CborValue>([[0, 1], [1, assessment({ action: "create" })]]);
      // The lock appeared after review: its create-only write must fail natively.
      if (p.has(7)) out.set(2, [new Map<number, CborValue>([[0, "mdbase.lock.yaml"], [1, "lock\n"], [3, true]])]);
      return out;
    });
    const client = await connect({ connector, app });
    const plan = await client.typePacks.plan(pack, options);
    const submit = client.submit.bind(client);
    const writes: Awaited<ReturnType<typeof submit>>[] = [];
    client.submit = async (...args) => { const w = await submit(...args); writes.push(w); return w; };
    const error = await client.typePacks.apply(plan).catch((e: unknown) => e);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]!.state).toBe("rejected");
    expect(error).toSatisfy((e) => isMdbaseError(e, "conflict") && e.mutationId === writes[0]![0]!.mutationId);
    expect((await client.resources.get("mdbase.lock.yaml")).text).toBe("theirs\n");
    // A dry run that would be rejected is refused too, never shown as installable.
    await expect(client.typePacks.apply(plan, { dryRun: true })).rejects.toSatisfy((e) => isMdbaseError(e, "conflict"));
    client.close();
  });

  it("refuses at plan time without definitions.manage and surfaces older replicas", async () => {
    const replica = new MemoryReplica({});
    const { connector, seen } = withPlanner(replica, () => new Map<number, CborValue>([[0, 1], [1, assessment({ action: "create", manage: false })]]));
    const client = await connect({ connector, app });
    const plan = await client.typePacks.plan(pack, options);
    expect(plan).toMatchObject({ canApply: false, refusal: { code: "forbidden" } });
    await expect(client.typePacks.apply(plan)).rejects.toSatisfy((e) => isMdbaseError(e, "forbidden"));
    expect(seen).toHaveLength(1);
    await expect(client.typePacks.plan(pack, { ...options, contractSetups: [{ contract: "x" }] } as typeof options))
      .rejects.toSatisfy((e) => isMdbaseError(e, "invalid_request") && e.reason === "type_pack_contract_setups_unsupported");
    client.close();

    const old = await connect({ connector: new MemoryReplica({}).connector(), app });
    await expect(old.typePacks.plan(pack, options)).rejects.toSatisfy((e) => isMdbaseError(e, "upgrade_required") && e.reason === "type_packs_unsupported");
    old.close();
  });
});
