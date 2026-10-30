import { describe, expect, it } from "vitest";
import { connect, Write, type Connector, type FramePort, type FileWrite, type wire } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame, helloResult, openUploadParams } from "../src/wire.js";
import { uuid as uuidCodec } from "../src/codec.js";
import { uuidv7 } from "../src/values.js";
import type { CborValue } from "../src/cbor.js";

type Edit = (reply: Map<number, CborValue>) => Map<number, CborValue>;
function observe(replica: MemoryReplica, edit?: Edit, minor = 0, singleLane = false) {
  const base = replica.connector();
  const methods: string[] = [];
  const uploadPaths: string[] = [];
  const connector: Connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const requests = new Map<number, string>();
      let lane: string | null = null;
      const port: FramePort = {
        onframe: null, onclose: null,
        close: () => opened.port.close(),
        send(frame) {
          const request = clientFrame.dec(frame);
          if (request.kind === "request") {
            methods.push(request.method);
            requests.set(request.id, request.method);
            if (request.method === "open_upload") uploadPaths.push(openUploadParams.dec(request.params!).path);
            // MemoryReplica supports multiple transfers. Model the native
            // replica's single lane here, and free it only after a commit reply.
            if (singleLane && request.method === "open_upload") {
              const transfer = openUploadParams.dec(request.params!).transfer;
              if (lane !== null && lane !== transfer) {
                queueMicrotask(() => port.onframe?.(clientFrame.enc({kind:"response",id:request.id,problem:{code:"conflict",recovery:"resolve_conflict",reason:"attachment_upload_scope_changed",message:"the live upload request changed"}})));
                return;
              }
              lane = transfer;
            }
          }
          opened.port.send(frame);
        },
      };
      opened.port.onframe = frame => {
        const reply = clientFrame.dec(frame);
        if (reply.kind === "response" && ["commit_upload", "abort_upload"].includes(requests.get(reply.id) ?? "")) lane = null;
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
  return { connector, methods, uploadPaths };
}

const app = { name: "file-identity-test", version: "0.0.0" };
describe("replica-owned upload identity", () => {
  it.each([false,true])("queues concurrent uploads through one lane without waiting for confirmation (slow first source: %s)", async slow => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    const observed = observe(replica, undefined, 1, true);
    const client = await connect({ connector: observed.connector, app });
    const bytes = Uint8Array.of(1, 2, 3), first = slow ? new Blob([bytes]) : bytes;
    if (first instanceof Blob) {
      // Slow first-source reads also prove that hashing cannot reorder callers.
      const slice = first.slice.bind(first);
      first.slice = (...args) => {
        const part = slice(...args), read = part.arrayBuffer.bind(part);
        part.arrayBuffer = async () => { await new Promise(resolve => setTimeout(resolve, 10)); return read(); };
        return part;
      };
    }
    try {
      const [a, b] = await Promise.all([
        client.files.upload("a.bin", first),
        client.files.upload("b.bin", Uint8Array.of(4, 5)),
      ]);
      expect(observed.uploadPaths).toEqual(["a.bin", "b.bin"]);
      expect(observed.methods.filter(method => ["open_upload", "commit_upload"].includes(method))).toEqual(["open_upload", "commit_upload", "open_upload", "commit_upload"]);
      expect(a.state).toBe("pending");expect(b.state).toBe("pending");
      replica.confirmAll();await Promise.all([a.confirmed, b.confirmed]);
      expect(await client.files.download(a.fileId)).toEqual(Uint8Array.of(1, 2, 3));
      expect(await client.files.download(b.fileId)).toEqual(Uint8Array.of(4, 5));
    } finally { client.close(); }
  });

  it("a failed or cancelled queued upload does not stop the next caller", async () => {
    const replica = new MemoryReplica({ confirmDelayMs: null });
    let first = true;
    const observed = observe(replica, reply => { if (first) { first = false; reply.delete(4); } return reply; }, 1, true);
    const client = await connect({ connector: observed.connector, app }), cancelled = new AbortController();
    try {
      const failed = expect(client.files.upload("bad.bin", Uint8Array.of(1))).rejects.toMatchObject({reason:"file_upload_identity_missing"});
      const skipped = expect(client.files.upload("cancelled.bin", Uint8Array.of(2), {signal:cancelled.signal})).rejects.toMatchObject({code:"cancelled"});
      const next = client.files.upload("next.bin", Uint8Array.of(3));cancelled.abort();
      await Promise.all([failed, skipped]);
      expect((await client.files.get((await next).fileId)).path).toBe("next.bin");
      expect(observed.methods.filter(method => method === "open_upload")).toHaveLength(2);
    } finally { client.close(); }
  });

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
