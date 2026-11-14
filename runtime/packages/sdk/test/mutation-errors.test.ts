import { describe, expect, it } from "vitest";
import { isMdbaseError, MdbaseError, uuidv7 } from "../src/index.js";
import { connect, type Connector, type FramePort } from "../src/thin-client.js";
import { MemoryReplica } from "../src/testing/index.js";
import { WriteRefusal } from "../src/session.js";
import { clientFrame, submitParams, submitResult, type Problem } from "../src/wire.js";

const app = { name: "mutation-error-test", version: "0.0.0" };

/** A replica that answers `submit` requests itself and records the mutations sent. */
function answeringSubmit(replica: MemoryReplica, answer: (mutationId: string) => { problem: Problem } | { result: ReturnType<typeof submitResult.enc> } | null) {
  const base = replica.connector();
  const sent: string[] = [];
  const connector: Connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const lost = new Set<number>();
      const port: FramePort = {
        onframe: null, onclose: null,
        close: () => opened.port.close(),
        send(frame) {
          const request = clientFrame.dec(frame);
          if (request.kind === "request" && request.method === "submit") {
            const p = submitParams.dec(request.params);
            sent.push(p.mutationId!);
            const answered = answer(p.mutationId!);
            if (answered === null) { lost.add(request.id); opened.port.send(frame); return; }
            queueMicrotask(() => port.onframe?.(clientFrame.enc({ kind: "response", id: request.id, ...answered })));
            return;
          }
          opened.port.send(frame);
        },
      };
      opened.port.onframe = frame => {
        const response = clientFrame.dec(frame);
        if (response.kind === "response" && lost.delete(response.id)) { opened.port.close(); return; }
        port.onframe?.(frame);
      };
      opened.port.onclose = error => port.onclose?.(error);
      return { ...opened, port };
    },
  };
  return { connector, sent };
}
const refusingSubmit = (replica: MemoryReplica, problem: Problem) => answeringSubmit(replica, () => ({ problem }));

async function failure(p: Promise<unknown>): Promise<MdbaseError> {
  try {
    await p;
  } catch (e) {
    if (isMdbaseError(e)) return e;
    throw e;
  }
  throw new Error("expected a failure");
}

describe("native write errors carry the original mutation identity", () => {
  it.each(["invalid_request", "invalid_record", "not_found", "conflict", "unauthenticated", "forbidden", "collection_invalid", "rate_limited", "too_large", "upgrade_required"])("distinguishes an authenticated %s submit refusal from ambiguous failure", async code => {
    const { connector, sent } = refusingSubmit(new MemoryReplica({}), { code, recovery: "fix_request", message: "refused" });
    const client = await connect({ connector, app });
    try {
      const error = await failure(client.create({ path: "refused.md" }));
      expect(error).toBeInstanceOf(WriteRefusal);
      expect(error.mutationId).toBe(sent[0]);
    } finally { client.close(); }
  });

  it.each(["outcome_unknown", "unavailable", "cancelled", "internal", "quota_exceeded"])("retains ambiguous %s responses without refusal proof", async code => {
    const { connector } = refusingSubmit(new MemoryReplica({}), { code, recovery: "resolve_outcome", message: "uncertain" });
    const client = await connect({ connector, app });
    try { expect(await failure(client.create({ path: "uncertain.md" }))).not.toBeInstanceOf(WriteRefusal); }
    finally { client.close(); }
  });

  it("does not mistake a refusal after reconnect for proof that the lost first submit applied nothing", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    let calls = 0;
    const { connector, sent } = answeringSubmit(replica, () => ++calls === 1 ? null : {
      problem: { code: "forbidden", recovery: "reauthorize", message: "grant revoked after capture" },
    });
    const client = await connect({ connector, app, reconnect: { minDelayMs: 1, maxDelayMs: 1 } });
    try {
      const error = await failure(client.create({ path: "captured.md", body: "captured" }));
      expect(error).toMatchObject({ code: "forbidden", mutationId: sent[0] });
      expect(error).not.toBeInstanceOf(WriteRefusal);
      expect(sent).toEqual([sent[0], sent[0]]);
      expect((await client.pendingWrites())[0]!.receipt.mutation).toBe(sent[0]);
    } finally { client.close(); }
  });

  it("a rejected outcome names the mutation it settles", async () => {
    const client = await connect({ connector: new MemoryReplica({ confirmDelayMs: null }).connector(), app });
    const write = await client.update(uuidv7(), { patch: { title: "x" } });
    const error = await failure(write.confirmed);
    expect(error.code).toBe("not_found");
    expect(error.mutationId).toBe(write.mutationId);
    client.close();
  });

  it("a refused submit keeps the identity that was sent, SDK-minted or the caller's", async () => {
    const refusal: Problem = { code: "outcome_unknown", recovery: "resolve_outcome", message: "commit uncertain" };
    const { connector, sent } = refusingSubmit(new MemoryReplica({}), refusal);
    const client = await connect({ connector, app });

    const minted = await failure(client.create({ path: "a.md" }));
    expect(minted.code).toBe("outcome_unknown");
    expect(minted.mutationId).toBe(sent[0]);

    const mutationId = uuidv7();
    const given = await failure(client.create({ path: "b.md" }, { mutationId }));
    expect(given.mutationId).toBe(mutationId);
    expect(given.toProblem()).toEqual(refusal);

    const several = await failure(client.submit([{ kind: "create", id: uuidv7(), path: "c.md" }, { kind: "create", id: uuidv7(), path: "d.md" }]));
    expect(several.mutationId).toBe(sent[2]);
    client.close();
  });

  it("a submit answered with more than one receipt fails under the mutation that was sent", async () => {
    const { connector, sent } = answeringSubmit(new MemoryReplica({}), mutation => ({
      result: submitResult.enc([{ mutation, state: "pending" }, { mutation: uuidv7(), state: "pending" }]),
    }));
    const client = await connect({ connector, app });
    const error = await failure(client.create({ path: "a.md" }));
    expect(error).toMatchObject({ code: "internal", reason: "invalid_submit_response", mutationId: sent[0] });
    client.close();
  });

  it("a dry run captures nothing and names no mutation", async () => {
    const { connector } = refusingSubmit(new MemoryReplica({}), { code: "forbidden", recovery: "reauthorize", message: "no" });
    const client = await connect({ connector, app });
    const error = await failure(client.create({ path: "a.md" }, { dryRun: true }));
    expect(error.mutationId).toBeUndefined();
    client.close();
  });
});
