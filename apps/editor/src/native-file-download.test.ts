import { describe, expect, it, vi } from "vitest";
import { MdbaseError, type FilesApi, type FileView } from "@mdbase-dev/sdk";
import { downloadNativeFile, type NativeFileSelection } from "./native-file-download";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Public-interface doubles exercise Editor fencing and cleanup ordering only.
// SDK pre-open cleanup/reproduction is independently owned and not proven here.
function fixture(overrides: Partial<FileView> = {}) {
  const file: FileView = {
    id: "00000000-0000-4000-8000-000000000001", path: "attachments/source.md",
    digest: `sha256:${"a".repeat(64)}`, size: 2, confirmedSeq: 7,
    contentProfile: "unindexed_markdown_blob", media: "other", state: "materialized",
    mediaType: "text/markdown", ...overrides
  };
  const selection: NativeFileSelection = { ...file };
  const metadata = deferred<FileView>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const underlyingCancel = vi.fn();
  const stream: ReturnType<FilesApi["downloadStream"]> = Object.assign(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel: underlyingCancel
  }), { file: metadata.promise });
  // Keep a handle to the actual owned reader, including cancellation on an
  // already-errored stream (where the underlying source's cancel won't run).
  const reader = stream.getReader();
  const nativeCancel = reader.cancel.bind(reader);
  const cancel = vi.spyOn(reader, "cancel");
  const release = vi.spyOn(reader, "releaseLock");
  const nativeRead = reader.read.bind(reader);
  const read = vi.spyOn(reader, "read");
  vi.spyOn(stream, "getReader").mockReturnValue(reader);
  const files = { downloadStream: vi.fn<FilesApi["downloadStream"]>(() => stream) };
  const abort = new AbortController();
  const isCurrent = vi.fn(() => true);
  const options = { signal: abort.signal, isCurrent };
  const start = (selected = selection, maxBytes?: number) => downloadNativeFile(files, selected, { ...options, maxBytes });
  return { file, selection, metadata, controller, stream, reader, cancel, release, read, nativeRead, nativeCancel, underlyingCancel,
    files, abort, isCurrent, options, start };
}

const expectCancelled = (pending: Promise<unknown>) => expect(pending).rejects.toMatchObject({
  code: "cancelled", recovery: "none"
});

async function reading(f: ReturnType<typeof fixture>) {
  await vi.waitFor(() => expect(f.read).toHaveBeenCalled());
}

describe("downloadNativeFile", () => {
  it("pins the selected digest with no range and publishes only on successful completion", async () => {
    const f = fixture();
    const published = vi.fn();
    const pending = f.start().then(bytes => { published(bytes); return bytes; });
    expect(f.files.downloadStream).toHaveBeenCalledTimes(1);
    expect(f.files.downloadStream).toHaveBeenCalledWith(f.file.id, {
      revision: f.file.digest, signal: f.abort.signal
    });
    expect(f.files.downloadStream.mock.calls[0]![1]).not.toHaveProperty("range");
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([104]));
    f.controller.enqueue(new Uint8Array([105]));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(3));
    expect(published).not.toHaveBeenCalled();
    f.controller.close();
    await expect(pending).resolves.toEqual(new Uint8Array([104, 105]));
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.stream.locked).toBe(false);
  });

  it("supports a bounded empty full file", async () => {
    const f = fixture({ size: 0 });
    const pending = f.start(f.selection, 0);
    f.metadata.resolve(f.file);
    f.controller.close();
    await expect(pending).resolves.toEqual(new Uint8Array());
  });

  it.each([
    { id: "00000000-0000-4000-8000-000000000002" },
    { path: "attachments/moved.md" },
    { digest: `sha256:${"b".repeat(64)}` },
    { size: 3 },
    { size: 64 * 1024 * 1024 + 1 },
    { contentProfile: "ordinary_blob" as const },
    { contentProfile: undefined },
    { confirmedSeq: 8 }
  ])("rejects mismatched metadata without reading bytes: %j", async change => {
    const f = fixture();
    const pending = f.start();
    f.metadata.resolve({ ...f.file, ...change });
    await expect(pending).rejects.toThrow("changed");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.stream.locked).toBe(false);
  });

  it("rejects same-ID reuse even when path and digest match", async () => {
    const f = fixture();
    const pending = f.start();
    f.metadata.resolve({ ...f.file, confirmedSeq: f.file.confirmedSeq + 1 });
    await expect(pending).rejects.toThrow("changed");
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it("snapshots the selection and rechecks metadata before publication", async () => {
    const f = fixture();
    const mutable = { ...f.selection };
    const pending = f.start(mutable);
    mutable.digest = `sha256:${"b".repeat(64)}`;
    f.metadata.resolve(f.file);
    await reading(f);
    f.file.contentProfile = "ordinary_blob";
    f.controller.enqueue(new Uint8Array([104, 105]));
    f.controller.close();
    await expect(pending).rejects.toThrow("changed");
    expect(f.files.downloadStream.mock.calls[0]![1]!.revision).toBe(f.selection.digest);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects prior abort and stale selection before any SDK I/O", async () => {
    const aborted = fixture();
    aborted.abort.abort();
    await expectCancelled(aborted.start());
    expect(aborted.files.downloadStream).not.toHaveBeenCalled();
    const stale = fixture();
    stale.isCurrent.mockReturnValue(false);
    await expectCancelled(stale.start());
    expect(stale.files.downloadStream).not.toHaveBeenCalled();
  });

  it("has its abort listener installed during synchronous stream opening", async () => {
    const f = fixture();
    f.files.downloadStream.mockImplementation(() => {
      f.abort.abort();
      return f.stream;
    });
    await expectCancelled(f.start());
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.stream.locked).toBe(true);
    // Local exit cannot dispose the reader before the SDK's metadata barrier.
    f.metadata.resolve(f.file);
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.stream.locked).toBe(false);
  });

  it.each(["resolve", "reject"] as const)("rejects locally before blocked metadata, then cancels after its late %s", async outcome => {
    const f = fixture();
    const stopped = deferred<void>();
    f.underlyingCancel.mockImplementation(() => stopped.promise);
    const published = vi.fn();
    const pending = f.start().then(published);
    f.abort.abort();
    await expectCancelled(pending);
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.stream.locked).toBe(true);
    expect(f.read).not.toHaveBeenCalled();
    if (outcome === "resolve") f.metadata.resolve(f.file);
    else f.metadata.reject(new Error("late open failure"));
    await vi.waitFor(() => expect(f.cancel).toHaveBeenCalledTimes(1));
    expect(f.release).not.toHaveBeenCalled();
    // A rejected cancellation must be observed without masking local abort.
    stopped.reject(new Error("late cancel failure"));
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
    expect(f.stream.locked).toBe(false);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(published).not.toHaveBeenCalled();
  });

  it("orders cancellation after metadata in a response/continuation microtask gap model", async () => {
    const f = fixture();
    const response = deferred<void>();
    const order: string[] = [];
    // Model only the documented boundary: response handling can abort before
    // the SDK continuation assigns its ID and fulfills public stream.file.
    // This is NOT execution/reproduction of the real SDK's request machinery.
    const gap = response.promise.then(() => {
      order.push("response; abort");
      f.abort.abort();
      expect(f.underlyingCancel).not.toHaveBeenCalled();
    });
    const opened = gap.then(() => { order.push("ID assigned; metadata"); f.metadata.resolve(f.file); });
    f.cancel.mockImplementation(reason => {
      order.push("cancel");
      return f.nativeCancel(reason);
    });
    const pending = f.start();
    const rejected = expectCancelled(pending);
    response.resolve(undefined);
    await rejected;
    await opened;
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["response; abort", "ID assigned; metadata", "cancel"]);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.underlyingCancel).toHaveBeenCalledTimes(1);
    expect(f.stream.locked).toBe(false);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("fences staleness during synchronous opening but retains cleanup ownership until metadata", async () => {
    const f = fixture();
    f.files.downloadStream.mockImplementation(() => {
      f.isCurrent.mockReturnValue(false);
      return f.stream;
    });
    await expectCancelled(f.start());
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    f.metadata.resolve(f.file);
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(1));
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
  });

  it("cancels a reader blocked on its first chunk", async () => {
    const f = fixture();
    const pending = f.start();
    f.metadata.resolve(f.file);
    await reading(f);
    f.abort.abort();
    await expectCancelled(pending);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.stream.locked).toBe(false);
  });

  it("does not return already buffered provisional bytes after abort", async () => {
    const f = fixture();
    const pending = f.start();
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([104, 105]));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    f.abort.abort();
    await expectCancelled(pending);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects abort at completion even when the stream is already closed", async () => {
    const f = fixture();
    f.read.mockImplementation(async () => {
      const result = await f.nativeRead();
      if (result.done) f.abort.abort();
      return result;
    });
    const pending = f.start();
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([104, 105]));
    f.controller.close();
    await expectCancelled(pending);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["metadata", "chunk", "completion"] as const)("fences stale selection at %s settlement", async stage => {
    const f = fixture();
    const pending = f.start();
    if (stage === "metadata") {
      f.isCurrent.mockReturnValue(false);
      f.metadata.resolve(f.file);
    } else {
      f.metadata.resolve(f.file);
      await reading(f);
      if (stage === "chunk") {
        f.isCurrent.mockReturnValue(false);
        f.controller.enqueue(new Uint8Array([104, 105]));
      } else {
        f.controller.enqueue(new Uint8Array([104, 105]));
        await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
        f.isCurrent.mockReturnValue(false);
        f.controller.close();
      }
    }
    await expectCancelled(pending);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.stream.locked).toBe(false);
  });

  it.each(["resolve", "reject"] as const)("observes a pending read's late %s after abort", async outcome => {
    const f = fixture();
    const late = deferred<ReadableStreamReadResult<Uint8Array>>();
    f.read.mockImplementationOnce(() => late.promise);
    const pending = f.start();
    f.metadata.resolve(f.file);
    await reading(f);
    f.abort.abort();
    await expectCancelled(pending);
    if (outcome === "resolve") late.resolve({ done: false, value: new Uint8Array([104, 105]) });
    else late.reject(new Error("late read failure"));
    await Promise.resolve();
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates native integrity failure after all claimed bytes were provisionally received", async () => {
    const f = fixture();
    const failure = new Error("native whole-file integrity verification failed");
    const pending = f.start();
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([104, 105]));
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
    f.controller.error(failure);
    await expect(pending).rejects.toBe(failure);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.files.downloadStream).toHaveBeenCalledTimes(1);
  });

  it.each(["metadata", "stream"] as const)("preserves Hosted unavailable/recovery-none at %s without fallback", async stage => {
    const f = fixture();
    const failure = new MdbaseError({ code: "unavailable", recovery: "none", message: "Hosted file unavailable" });
    const pending = f.start();
    if (stage === "metadata") f.metadata.reject(failure);
    else {
      f.metadata.resolve(f.file);
      await reading(f);
      f.controller.error(failure);
    }
    await expect(pending).rejects.toBe(failure);
    expect(f.files.downloadStream).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([{ values: [104] }, { values: [104, 105, 106] }])("rejects underflow/overflow after chunk $values", async ({ values }) => {
    const f = fixture();
    const pending = f.start();
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array(values));
    f.controller.close();
    await expect(pending).rejects.toThrow(values.length < 2 ? "before" : "exceeded");
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it("counts multiple chunks cumulatively", async () => {
    const f = fixture();
    const pending = f.start();
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([104]));
    f.controller.enqueue(new Uint8Array([105, 106]));
    await expect(pending).rejects.toThrow("exceeded");
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid size %s before opening", async size => {
    const f = fixture({ size });
    await expect(f.start()).rejects.toThrow("invalid size");
    expect(f.files.downloadStream).not.toHaveBeenCalled();
  });

  it("rejects oversized selections before opening, including caller-lowered limits", async () => {
    const huge = fixture({ size: 64 * 1024 * 1024 + 1 });
    await expect(huge.start()).rejects.toMatchObject({ code: "too_large" });
    expect(huge.files.downloadStream).not.toHaveBeenCalled();
    const small = fixture();
    await expect(small.start(small.selection, 1)).rejects.toMatchObject({ code: "too_large" });
    expect(small.files.downloadStream).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, 0.5, 64 * 1024 * 1024 + 1])("cannot raise or invalidate the limit: %s", async limit => {
    const f = fixture();
    await expect(f.start(f.selection, limit)).rejects.toThrow("limit");
    expect(f.files.downloadStream).not.toHaveBeenCalled();
  });

  it.each(["unindexed_markdown_blob", "unindexed_markdown_attachment_v1"] as const)("requires fatal UTF-8 for %s", async contentProfile => {
    const f = fixture({ contentProfile });
    const pending = f.start();
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([0xc3, 0x28]));
    f.controller.close();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(f.cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["ordinary_blob", "ordinary_attachment_v1", undefined,
    // Future profiles are unknown (the public wire decoder normally omits them).
    "future_profile" as FileView["contentProfile"]
  ] as const)("preserves binary bytes for profile %s, regardless of Markdown filename/MIME", async contentProfile => {
    const f = fixture({ contentProfile });
    const pending = f.start();
    f.metadata.resolve(f.file);
    const binary = new Uint8Array([0xff, 0x00]);
    f.controller.enqueue(binary);
    f.controller.close();
    await expect(pending).resolves.toEqual(binary);
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it("assembles a split UTF-8 sequence before validating Markdown", async () => {
    const f = fixture();
    const pending = f.start();
    f.metadata.resolve(f.file);
    f.controller.enqueue(new Uint8Array([0xc3]));
    f.controller.enqueue(new Uint8Array([0xa9]));
    f.controller.close();
    await expect(pending).resolves.toEqual(new Uint8Array([0xc3, 0xa9]));
  });
});
