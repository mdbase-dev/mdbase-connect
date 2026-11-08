import { expect, it } from "vitest";
import { connect, type Connector, type FramePort } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame } from "../src/wire.js";

it.each([false, true])("releases the upload lane when Stop races commit (captured=%s)", async captured => {
  const replica = new MemoryReplica({ confirmDelayMs: null }), base = replica.connector();
  let reachedCommit!: () => void;
  const committing = new Promise<void>(resolve => { reachedCommit = resolve; });
  let active = false, commits = 0, aborted = 0, blocked: number | undefined;
  const connector: Connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const port: FramePort = {
        onframe: null, onclose: null, close: () => opened.port.close(),
        send(frame) {
          const request = clientFrame.dec(frame);
          if (request.kind === "request") {
            if (request.method === "open_upload") {
              if (active) {
                queueMicrotask(() => port.onframe?.(clientFrame.enc({
                  kind: "response", id: request.id,
                  problem: { code: "conflict", reason: "attachment_upload_scope_changed", recovery: "contact_support", message: "the live upload request changed" },
                })));
                return;
              }
              active = true;
            }
            if (request.method === "abort_upload") { active = false; aborted++; }
            if (request.method === "commit_upload" && commits++ === 0) {
              blocked = request.id;
              if (captured) opened.port.send(frame);
              reachedCommit();
              return;
            }
          }
          opened.port.send(frame);
        },
      };
      opened.port.onframe = frame => {
        const response = clientFrame.dec(frame);
        if (response.kind === "response" && response.id === blocked) return;
        port.onframe?.(frame);
      };
      opened.port.onclose = error => port.onclose?.(error);
      return { ...opened, port };
    },
  };
  const client = await connect({ connector, app: { name: "upload-cancel", version: "test" }, reconnect: false });
  try {
    const stop = new AbortController();
    const first = client.files.upload("files/stopped.bin", new Uint8Array([1, 2]), { signal: stop.signal });
    const outcome = expect(first).rejects.toMatchObject({ code: "cancelled" });
    await committing;
    stop.abort();
    await outcome;
    expect(aborted).toBe(1);
    const second = await client.files.upload("files/fresh.bin", new Uint8Array([3, 4]));
    replica.confirmAll();
    await second.confirmed;
    const files = [];
    for await (const file of client.files.list()) files.push(file.path);
    expect(files.sort()).toEqual(captured ? ["files/fresh.bin", "files/stopped.bin"] : ["files/fresh.bin"]);
  } finally { client.close(); }
});
