import { describe, expect, it } from "vitest";
import { connect, type Connector, type FramePort } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame } from "../src/wire.js";

type Relay = { connector: Connector; methods: string[]; busyReads: number; holdChunks: boolean };

/** Refuses the first `busyReads` read_file calls as the hosted replica does while
 * another transfer holds its attachment region; can withhold chunks to keep a
 * stream open. */
function relay(replica: MemoryReplica, busyReads: number): Relay {
  const base = replica.connector();
  const state: Relay = { connector: undefined as never, methods: [], busyReads, holdChunks: false };
  state.connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const port: FramePort = {
        onframe: null, onclose: null,
        close: () => opened.port.close(),
        send(frame) {
          const request = clientFrame.dec(frame);
          if (request.kind === "request") {
            state.methods.push(request.method);
            if (request.method === "read_file" && state.busyReads > 0) {
              state.busyReads--;
              queueMicrotask(() => port.onframe?.(clientFrame.enc({
                kind: "response",
                id: request.id,
                problem: {
                  code: "unavailable",
                  recovery: "retry",
                  message: "hosted attachment region is busy",
                  reason: "hosted_chunk_busy",
                  retryAfterMs: 1,
                },
              })));
              return;
            }
          }
          opened.port.send(frame);
        },
      };
      opened.port.onframe = frame => {
        const decoded = clientFrame.dec(frame);
        if (state.holdChunks && decoded.kind === "push" && decoded.type === "file_chunk") return;
        port.onframe?.(frame);
      };
      opened.port.onclose = error => port.onclose?.(error);
      return { ...opened, port };
    },
  };
  return state;
}

const app = { name: "file-download-test", version: "0.0.0" };
async function seeded(busyReads = 0) {
  const replica = new MemoryReplica({ confirmDelayMs: null });
  const observed = relay(replica, busyReads);
  const client = await connect({ connector: observed.connector, app });
  const write = await client.files.upload("files/paper.pdf", new Uint8Array([1, 2, 3, 4]));
  replica.confirmAll();
  await write.confirmed;
  return { client, observed };
}

describe("downloads and the replica's attachment region", () => {
  it("opens again when the region is busy instead of failing the read", async () => {
    const { client, observed } = await seeded(2);
    try {
      const bytes = await client.files.download({ path: "files/paper.pdf" });
      expect([...bytes]).toEqual([1, 2, 3, 4]);
      expect(observed.methods.filter(m => m === "read_file")).toHaveLength(3);
    } finally { client.close(); }
  });

  it("stops waiting for the region when the read is aborted", async () => {
    const { client } = await seeded(Number.POSITIVE_INFINITY);
    try {
      const ac = new AbortController();
      const read = client.files.download({ path: "files/paper.pdf" }, { signal: ac.signal });
      setTimeout(() => ac.abort(), 20);
      await expect(read).rejects.toMatchObject({ code: "cancelled" });
    } finally { client.close(); }
  });

  it("releases an open stream on the replica when its signal aborts", async () => {
    const { client, observed } = await seeded();
    try {
      observed.holdChunks = true;
      const ac = new AbortController();
      const stream = client.files.downloadStream({ path: "files/paper.pdf" }, { signal: ac.signal });
      await stream.file;
      const read = stream.getReader().read();
      ac.abort();
      await expect(read).rejects.toMatchObject({ code: "cancelled" });
      await Promise.resolve();
      expect(observed.methods).toContain("cancel_stream");
    } finally { client.close(); }
  });
});
