import assert from "node:assert/strict";
import { mdbaseError } from "@mdbase-dev/sdk";
import { MemoryReplica } from "@mdbase-dev/sdk/testing";

const replica = new MemoryReplica({ confirmDelayMs: 0 });
replica.seed({ path: "retry.md", body: "Original" });
const client = await replica.client();
let lease = await client.records.open({ path: "retry.md" });
try {
  lease.session.setBody("Unsent edit");
  replica.failNextWrite(mdbaseError("forbidden", "Temporarily read-only").toProblem());
  const first = await lease.session.flush();
  assert.equal(first.ok, false);
  assert.equal(first.problem.code, "forbidden");
  const refused = lease.session.getSnapshot();
  const second = await lease.session.flush();
  const retried = lease.session.getSnapshot();
  lease.release();
  lease = await client.records.open({ path: "retry.md" });
  const reopened = await lease.session.flush();
  console.log(JSON.stringify({ first, second, reopened, afterRefusal: refused.state, afterRetry: retried.state,
    sameRecoveryIdentity: refused.recovery !== null && refused.recovery.mutationId === retried.recovery?.mutationId,
    submittedWrite: Boolean(retried.recovery?.write), receipt: Boolean(retried.recovery?.receipt),
    dirty: retried.dirty }, null, 2));
  assert.equal(second.ok, true, "A definitive refusal must permit a later deliberate save once access is available");
  assert.equal((await client.get({ path: "retry.md" }, { include: { body: true } })).body, "Unsent edit");
} finally {
  lease.release();
  client.close();
}
