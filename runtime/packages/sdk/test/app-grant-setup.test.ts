/** Private collection setup over a client: one review, one guarded mutation. */
import { describe, expect, it } from "vitest";
import { privateCollectionSetup, type PrivateSetupEngine } from "../src/app-grant/setup.js";
import type { MdbaseClient } from "../src/client.js";
import type { Op } from "../src/wire.js";

const TYPE = "_types/task.md", DOC = "---\nname: task\n---\n";
const digest = (rows: readonly (readonly [string, string])[]) => `sha256:${String(rows.length).padStart(64, "0")}`;
/** Plans one type definition until it exists; the digest binds the inventory. */
const engine: PrivateSetupEngine = {
  assess: (_m, rows, decisions) => ({
    status: rows.some(([p]) => p === TYPE) ? "current" : "provision", assessmentDigest: digest(rows),
    ...(decisions ? { review: { configuration: [], staged: [{ path: TYPE, document: DOC }], packs: [{ id: "tasks", version: "1.0.0", status: "install", installedVersion: null,
      resources: rows.some(([p]) => p === TYPE) ? [] : [{ target: TYPE, kind: "type", mode: "managed", action: "create", installed: false }] }] } } : {}),
  }),
  plan: (_m, expected, rows) => {
    if (expected !== digest(rows)) throw new Error("stale");
    return { assessmentDigest: expected, provisionDigest: expected, packs: [], sources: [], resourceReadback: [],
      resourceOps: [{ kind: "resource_put", path: TYPE, doc: DOC, mustNotExist: true }] };
  },
};
function relayClient(o: { reject?: boolean } = {}) {
  const files = new Map<string, string>([["mdbase.yaml", "settings: {}\n"]]);
  const submitted: Op[][] = [];
  const client = {
    resources: { list: async () => ({ complete: true, resources: [...files].sort(([a], [b]) => a < b ? -1 : 1)
      .map(([path, text]) => ({ path, text, size: new TextEncoder().encode(text).length, state: "confirmed", revision: "sha256:0" })) }) },
    readyForRead: async () => ({ hello: { grant: { capabilities: ["definitions.manage", "records.create"] } } }),
    find: async () => null,
    submit: async (ops: Op[]) => {
      submitted.push(ops);
      if (o.reject) return [{ mutationId: "m1", receipt: { state: "rejected" }, confirmed: Promise.reject(new Error("guard")) }];
      for (const op of ops) if (op.kind === "resource_put") files.set(op.path, op.doc);
      return [{ mutationId: "m1", receipt: { state: "confirmed" }, confirmed: Promise.resolve({ state: "confirmed", status: "applied" }) }];
    },
  } as unknown as MdbaseClient;
  return { client, files, submitted };
}
const setupFor = (client: MdbaseClient) => privateCollectionSetup({ client, manifest: {}, operations: ["apply_type_pack"], engine: async () => engine });

describe("Private collection setup", () => {
  it("reviews in plain words, then applies exactly the planned guarded writes as one mutation", async () => {
    const { client, submitted } = relayClient();
    const setup = setupFor(client);
    expect(await setup.assess()).toBe("setup_required");
    const plan = await setup.plan();
    expect(plan).toMatchObject({ status: "setup", canApply: true, summary: "This app will make 1 change to this collection." });
    expect(plan.changes).toEqual([{ kind: "create", target: TYPE, message: 'Add the "task" record type.' }]);
    expect(await setup.apply(plan)).toBe("ready");
    expect(submitted).toEqual([[{ kind: "resource_put", path: TYPE, doc: DOC, mustNotExist: true }]]);
    expect(await setup.assess()).toBe("ready");
  });

  it("refuses setup_changed without writing when the collection moved after review", async () => {
    const { client, files, submitted } = relayClient();
    const setup = setupFor(client);
    const plan = await setup.plan();
    files.set("notes.md", "x");
    await expect(setup.apply(plan)).rejects.toMatchObject({ code: "conflict", reason: "setup_changed" });
    expect(submitted).toEqual([]);
  });

  it("maps a guard the computer rejected to setup_changed", async () => {
    const { client } = relayClient({ reject: true });
    const setup = setupFor(client);
    await expect(setup.apply(await setup.plan())).rejects.toMatchObject({ reason: "setup_changed", mutationId: "m1" });
  });
});
