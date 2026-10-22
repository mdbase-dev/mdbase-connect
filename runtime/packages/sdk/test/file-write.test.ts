import { describe, expect, it } from "vitest";
import { connect, Write, type Connector, type FramePort, type FileWrite, type wire } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame, helloResult } from "../src/wire.js";
import { uuid as uuidCodec } from "../src/codec.js";
import { uuidv7 } from "../src/values.js";
import type { CborValue } from "../src/cbor.js";

type Edit = (reply: Map<number, CborValue>) => Map<number, CborValue>;
function observe(replica: MemoryReplica, edit?: Edit, minor = 0) {
  const base = replica.connector();
  const methods: string[] = [];
  const connector: Connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const requests = new Map<number, string>();
      const port: FramePort = {
        onframe: null, onclose: null,
        close: () => opened.port.close(),
        send(frame) {
          const request = clientFrame.dec(frame);
          if (request.kind === "request") {
            methods.push(request.method);
            requests.set(request.id, request.method);
          }
          opened.port.send(frame);
        },
      };
      opened.port.onframe = frame => {
        const reply = clientFrame.dec(frame);
        if (edit && reply.kind === "response" && requests.get(reply.id) === "open_upload" && reply.result instanceof Map) {
          reply.result = edit(new Map(reply.result as Map<number, CborValue>));
          frame = clientFrame.enc(reply);
        }
        port.onframe?.(frame);
      };
      opened.port.onclose = error => port.onclose?.(error);
      const helloFrame = clientFrame.dec(opened.helloResponse);
      if (helloFrame.kind !== "response" || helloFrame.result === undefined) throw new Error("test hello missing");
      const result = helloResult.dec(helloFrame.result);
      helloFrame.result = helloResult.enc({ ...result, version: { major: 1, minor } });
      return { ...opened, port, helloResponse: clientFrame.enc(helloFrame) };
    },
  };
  return { connector, methods };
}

const app = { name: "file-identity-test", version: "0.0.0" };
describe("replica-owned upload identity", () => {
  it("exposes the original UUID on the tracked Write without looking up a path", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const observed = observe(replica);
    const client = await connect({ connector: observed.connector, app });
    try {
      const transferId = uuidv7();
      const original: FileWrite = await client.files.upload("img/original.png", new Uint8Array([1, 2, 3]), { transferId });
      expect(original).toBeInstanceOf(Write);
      expect(original.fileId).not.toBe(transferId);
      expect(original.state).toBe("pending");
      expect(observed.methods).not.toContain("get_file");
      replica.confirmAll();
      await original.confirmed;
      expect((await client.files.get(original.fileId)).id).toBe(original.fileId);

      await client.files.move(await client.files.get(original.fileId), "archive/original.png");
      const concurrent = await client.files.upload("img/original.png", new Uint8Array([9]));
      replica.confirmAll();
      await concurrent.confirmed;
      const byOriginalId = await client.files.get(original.fileId);
      expect(byOriginalId.path).toBe("archive/original.png");
      expect(byOriginalId.size).toBe(3);
      expect((await client.files.get({ path: "img/original.png" })).id).toBe(concurrent.fileId);
      expect(concurrent.fileId).not.toBe(original.fileId);
    } finally { client.close(); }
  });

  it("commits an empty file without fabricating an input fragment", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const observed = observe(replica, undefined, 1);
    const client = await connect({ connector: observed.connector, app });
    try {
      const original = await client.files.upload("files/empty.bin", new Blob([]));
      expect(observed.methods).toContain("open_upload");
      expect(observed.methods).not.toContain("upload_chunk");
      expect(observed.methods).toContain("commit_upload");
      replica.confirmAll();
      await original.confirmed;
      const view = await client.files.get(original.fileId);
      expect(view.id).toBe(original.fileId);
      expect(view.size).toBe(0);
    } finally { client.close(); }
  });

  it("refuses an older producer without identity before sending any file bytes or commit", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const observed = observe(replica, reply => { reply.delete(4); return reply; });
    const client = await connect({ connector: observed.connector, app });
    try {
      await expect(client.files.upload("a.png", new Uint8Array([1]))).rejects.toMatchObject({
        code: "upgrade_required", reason: "file_upload_identity_unsupported",
      });
      expect(observed.methods).not.toContain("upload_chunk");
      expect(observed.methods).not.toContain("commit_upload");
      expect(observed.methods).not.toContain("get_file");
    } finally { client.close(); }
  });

  it("treats missing identity from a negotiated 1.1 producer as an invariant failure", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const observed = observe(replica, reply => { reply.delete(4); return reply; }, 1);
    const client = await connect({ connector: observed.connector, app });
    try {
      await expect(client.files.upload("a.png", new Uint8Array([1]))).rejects.toMatchObject({
        code: "internal", reason: "file_upload_identity_missing",
      });
      expect(observed.methods).not.toContain("upload_chunk");
      expect(observed.methods).not.toContain("commit_upload");
    } finally { client.close(); }
  });

  it("refuses transfer/replacement identity mismatches rather than guessing", async () => {
    for (const mismatch of ["transfer", "replacement"] as const) {
      const replica = new MemoryReplica({ confirmDelayMs: null });
      const observed = observe(replica, reply => { reply.set(mismatch === "transfer" ? 0 : 4, uuidCodec.enc(uuidv7())); return reply; });
      const client = await connect({ connector: observed.connector, app });
      try {
        const options: { fileId?: wire.Uuid } = mismatch === "replacement" ? { fileId: uuidv7() } : {};
        await expect(client.files.upload("a.png", new Uint8Array([1]), options)).rejects.toMatchObject({
          code: "internal", reason: "file_upload_identity_mismatch",
        });
        expect(observed.methods).not.toContain("upload_chunk");
        expect(observed.methods).not.toContain("commit_upload");
      } finally { client.close(); }
    }
  });
});
