import type {
  JsonObject,
  MdbaseConnection,
  PendingMutation
} from "../../api-candidate/index.js";

export async function tasknotesSpike(connection: MdbaseConnection<JsonObject>): Promise<void> {
  const sync = connection.sync();
  if (sync) void sync.transport.openSession();
  for await (const listed of connection.files.list({ timeoutMs: 20_000 })) {
    const downloaded = await connection.files.downloadBytes(listed, { timeoutMs: 120_000 });
    if (downloaded.byteLength === 0) break;
  }
  const pending: readonly PendingMutation[] = connection.pendingMutations();
  for (const mutation of pending) await mutation.recover({ timeoutMs: 30_000 });
  const selected = pending[0] && connection.pendingMutation(pending[0].requestId);
  if (selected) await selected.recover();
  // @ts-expect-error recovery owns encrypted input; callers cannot resupply it.
  connection.resumePendingMutation({ path: "Tasks/one.md" });
}
