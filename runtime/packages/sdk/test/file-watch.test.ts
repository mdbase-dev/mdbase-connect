import { describe, expect, it } from "vitest";
import { connect, isMdbaseError, type Connector, type FramePort } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { changesResult, clientFrame, helloResult, type ChangesResult } from "../src/wire.js";

const app = { name: "file-watch-test", version: "0.0.0" };

function until(batches: ChangesResult[], n: number) {
  return expect.poll(() => batches.flatMap(b => b.changes).length).toBeGreaterThanOrEqual(n);
}

/** A connector whose test can inject `changes` pushes the replica never produced. */
function injectable(replica: MemoryReplica) {
  const base = replica.connector();
  let port: FramePort | null = null;
  const connector: Connector = {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      port = opened.port;
      return opened;
    },
  };
  const push = (batch: ChangesResult) => port!.onframe?.(clientFrame.enc({ kind: "push", type: "changes", payload: changesResult.enc(batch) }));
  return { connector, push };
}

/** A producer negotiated below API 1.2, whose change feed never names entities. */
function olderProducer(replica: MemoryReplica): Connector {
  const base = replica.connector();
  return {
    description: base.description,
    async open(hello, signal) {
      const opened = await base.open(hello, signal);
      const frame = clientFrame.dec(opened.helloResponse);
      if (frame.kind !== "response" || frame.result === undefined) throw new Error("test hello missing");
      frame.result = helloResult.enc({ ...helloResult.dec(frame.result), version: { major: 1, minor: 1 } });
      return { ...opened, helloResponse: clientFrame.enc(frame) };
    },
  };
}

describe("files.watch", () => {
  it("follows file puts, moves and removals, never record changes", async () => {
    const client = await connect({ connector: new MemoryReplica({}).connector(), app });
    const batches: ChangesResult[] = [];
    const watch = client.files.watch(batch => batches.push(batch));
    await watch.ready;
    await client.create({ path: "notes/a.md" });
    const upload = await client.files.upload("img/a.png", new Uint8Array([1]));
    const view = await client.files.get(upload.fileId);
    expect(view.mediaType).toBe("image/png");
    await client.files.move(view, "img/b.png");
    await client.files.delete(upload.fileId);
    await until(batches, 4);
    expect(batches.flatMap(b => b.changes).map(c => [c.kind, c.path])).toEqual([
      ["put", "img/a.png"], ["remove", "img/a.png"], ["put", "img/b.png"], ["remove", "img/b.png"],
    ]);
    watch();
    expect(watch.state).toBe("closed");
  });

  it("asks an unclassified put to re-read and passes an unclassified removal", async () => {
    const { connector, push } = injectable(new MemoryReplica({}));
    const client = await connect({ connector, app });
    const batches: ChangesResult[] = [];
    const watch = client.files.watch(batch => batches.push(batch));
    await watch.ready;
    push({ changes: [{ id: "0190a000-0000-7000-8000-000000000009", path: "", kind: "remove", version: 90 }], cursor: "90", reset: false });
    push({ changes: [{ id: "0190a000-0000-7000-8000-00000000000a", path: "x", kind: "put", version: 91 }], cursor: "91", reset: false });
    await expect.poll(() => batches.length).toBe(2);
    expect(batches[0]!).toMatchObject({ reset: false, changes: [{ kind: "remove", path: "" }] });
    expect(batches[1]!).toEqual({ changes: [], cursor: "91", reset: true });
    watch();
  });

  it("is refused on a producer whose feed cannot name files", async () => {
    const client = await connect({ connector: olderProducer(new MemoryReplica({})), app });
    let error: unknown;
    try { client.files.watch(() => {}); } catch (e) { error = e; }
    expect(isMdbaseError(error) && error.code).toBe("upgrade_required");
    client.close();
  });
});
