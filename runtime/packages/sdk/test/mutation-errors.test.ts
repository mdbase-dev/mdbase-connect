import { describe, expect, it } from "vitest";
import { isMdbaseError, MdbaseError, uuidv7 } from "../src/index.js";
import { connect, type Connector, type FramePort } from "../src/thin-client.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame, submitParams, submitResult, type Problem } from "../src/wire.js";

const app = { name: "mutation-error-test", version: "0.0.0" };

/** A replica that answers `submit` requests itself and records the mutations sent. */
function answeringSubmit(replica: MemoryReplica, answer: (mutationId: string) => { problem: Problem } | { result: ReturnType<typeof submitResult.enc> }) {
  const base = replica.connector();
  const sent: string[] = [];
  const connector: Connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const port: FramePort = {
        onframe: null, onclose: null,
        close: () => opened.port.close(),
        send(frame) {
          const request = clientFrame.dec(frame);
          if (request.kind === "request" && request.method === "submit") {
            const p = submitParams.dec(request.params);
            sent.push(p.mutationId!);
            const answered = answer(p.mutationId!);
            queueMicrotask(() => port.onframe?.(clientFrame.enc({ kind: "response", id: request.id, ...answered })));
            return;
          }
          opened.port.send(frame);
        },
      };
      opened.port.onframe = frame => port.onframe?.(frame);
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
