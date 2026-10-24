import { MdbaseError, type FilesApi, type FileView } from "@mdbase-dev/sdk";

/** Preserve the entire listed selection, not just the content digest: an ID can
 * be reused or its profile/path/confirmation can change without new bytes. */
export type NativeFileSelection = Readonly<Pick<FileView,
  "id" | "path" | "digest" | "size" | "contentProfile" | "confirmedSeq">>;

export interface NativeFileDownloadOptions {
  readonly signal: AbortSignal;
  /** Must include both the borrowed scope and the selected file. Abort `signal`
   * on invalidation to interrupt pending I/O; this predicate fences settlements. */
  readonly isCurrent: () => boolean;
  /** May lower, but never raise, the editor's existing 64 MiB preview ceiling. */
  readonly maxBytes?: number;
}

const MAX_BYTES = 64 * 1024 * 1024;

/** Full-file bytes only. `.file` and early chunks are provisional: native whole
 * verification is established only by successful stream completion. No retry,
 * fallback, client close, range read, or application-invented digest scheme.
 *
 * Retain reader ownership on local failure until `.file` settles: the SDK's
 * open continuation assigns its stream ID before fulfilling that metadata.
 * Cancelling earlier can miss that ID in a response/continuation gap. This is
 * Editor-side ordering mitigation, not proof of SDK/native remote cleanup. */
export async function downloadNativeFile(
  files: Pick<FilesApi, "downloadStream">,
  selection: NativeFileSelection,
  { signal, isCurrent, maxBytes = MAX_BYTES }: NativeFileDownloadOptions
): Promise<Uint8Array> {
  // Snapshot scalars so caller mutation cannot silently retarget the request.
  const selected = { ...selection };
  const cancelled = () => new MdbaseError({
    code: "cancelled", recovery: "none", message: "This file selection is no longer current."
  });
  const check = () => {
    if (signal.aborted || !isCurrent()) throw cancelled();
  };
  check();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BYTES)
    throw new RangeError("The file download limit must be between 0 and 64 MiB.");
  if (!Number.isSafeInteger(selected.size) || selected.size < 0)
    throw new RangeError("The selected file has an invalid size.");
  if (selected.size > maxBytes)
    throw new MdbaseError({ code: "too_large", recovery: "none", message: "This file exceeds the download limit." });

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let metadataBarrier: Promise<void> | undefined;
  let succeeded = false;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  const onAbort = () => { rejectAbort(cancelled()); };
  signal.addEventListener("abort", onAbort, { once: true });
  const settle = async <T>(pending: Promise<T>): Promise<T> => {
    // Promise.race observes late failures as well as late successful settlement.
    const value = await Promise.race([pending, aborted]);
    check();
    return value;
  };
  const match = (file: FileView) => {
    if (file.id !== selected.id || file.path !== selected.path || file.digest !== selected.digest
      || file.size !== selected.size || file.contentProfile !== selected.contentProfile
      || file.confirmedSeq !== selected.confirmedSeq)
      throw new Error("This file changed. Reload its preview.");
  };

  try {
    check();
    const stream = files.downloadStream(selected.id, { revision: selected.digest, signal });
    // Observe both outcomes even if local abort exits before open settles.
    metadataBarrier = stream.file.then(() => {}, () => {});
    reader = stream.getReader();
    check();
    const file = await settle(stream.file);
    match(file);
    const bytes = new Uint8Array(selected.size);
    let count = 0;
    for (;;) {
      check();
      const chunk = await settle(reader.read());
      if (chunk.done) break;
      if (chunk.value.byteLength > selected.size - count)
        throw new Error("The file stream exceeded its selected size.");
      bytes.set(chunk.value, count);
      count += chunk.value.byteLength;
    }
    if (count !== selected.size) throw new Error("The file stream ended before its selected size.");
    match(file);
    // Only actual persisted Markdown profiles qualify, never a filename/MIME.
    // AttachmentV1 and Blob have distinct SDK verification; both must be UTF-8
    // before the editor may use their completed bytes as Markdown.
    if (selected.contentProfile === "unindexed_markdown_blob"
      || selected.contentProfile === "unindexed_markdown_attachment_v1")
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    check();
    succeeded = true;
    return bytes;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (reader) {
      const ownedReader = reader;
      if (succeeded) ownedReader.releaseLock();
      else {
        // Do not await open/cancel on the local rejection path. Keep the lock
        // until delayed cancellation finishes so late open can still be cleaned
        // up exactly once, including after metadata or cancellation rejection.
        void metadataBarrier!.then(async () => {
          try { await ownedReader.cancel(); } catch { /* Preserve the original failure. */ }
          finally { ownedReader.releaseLock(); }
        });
      }
    }
  }
}
