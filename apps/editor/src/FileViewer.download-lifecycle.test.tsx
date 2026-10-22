import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesApi, FileView } from "@mdbase-dev/sdk";
import { FileViewer, FileWorkspace } from "./FileViewer";
import { FileAssetStore } from "./file-asset-store";
import type { CollectionFile, CollectionGateway } from "./model";
import { downloadNativeFile, type NativeFileSelection } from "./native-file-download";
import { useFileWorkspace } from "./use-file-workspace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function download(id: number) {
  const digest = `sha256:${String(id).repeat(64)}` as const;
  const file: FileView = {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    path: `image-${id}.png`, digest,
    size: 2, confirmedSeq: id, contentProfile: "ordinary_blob",
    media: "image", mediaType: "image/png", state: "materialized"
  };
  const metadata = deferred<FileView>();
  const order: string[] = [];
  void metadata.promise.then(() => { order.push("metadata"); }, () => { order.push("metadata failure"); });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const sourceCancel = vi.fn();
  const stream = Object.assign(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel: sourceCancel
  }), { file: metadata.promise });
  const reader = stream.getReader();
  const nativeCancel = reader.cancel.bind(reader);
  const cancel = vi.spyOn(reader, "cancel").mockImplementation(reason => {
    order.push("cancel");
    return nativeCancel(reason);
  });
  const release = vi.spyOn(reader, "releaseLock");
  const read = vi.spyOn(reader, "read");
  vi.spyOn(stream, "getReader").mockReturnValue(reader);
  const descriptor: CollectionFile = {
    fileId: file.id, path: file.path, revision: file.digest, contentDigest: digest,
    size: file.size, mediaType: file.mediaType, mediaClass: "image", modifiedAt: "",
    contentProfile: file.contentProfile, confirmedSeq: file.confirmedSeq
  };
  return { file, descriptor, metadata, controller, stream, cancel, sourceCancel, release, read, order };
}

// Actual production selection/acquisition hook and both production viewers.
// Only the omitted App shell and gateway boundary are test composition. The
// public-interface source adapter keeps selection records separately so these
// controls isolate component/store cancellation rather than claim SDK wire or
// Native cleanup qualification.
function Workspace({ store, files }: { store: FileAssetStore; files: readonly CollectionFile[] }) {
  const workspace = useFileWorkspace(store, files, "", "note.md");
  return <>
    {files.map(file => <button key={file.fileId} onClick={() => workspace.setSelectedFile(file)}>Select {file.path}</button>)}
    {workspace.selectedFile && workspace.selectedAsset && <FileWorkspace
      file={workspace.selectedFile} asset={workspace.selectedAsset}
      onBack={() => workspace.setSelectedFile(undefined)}
      onRetry={() => void store.retry(workspace.selectedFile!)}
    />}
    {workspace.selectedAsset?.status === "ready" && <button onClick={() => {
      if (workspace.selectedAsset?.status === "ready") workspace.setOpenAsset(workspace.selectedAsset);
    }}>Preview dialog</button>}
    <FileViewer asset={workspace.openAsset} onClose={() => workspace.setOpenAsset(undefined)} />
  </>;
}

beforeEach(() => {
  // Preserve URL's constructor: the production hook dynamically imports its
  // reference parser, and Vite's module runner also uses new URL().
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:successor");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

describe("production file workspace download lifetime (test source adapter)", () => {
  it("cannot invoke underlying source cancellation twice by cancelling an already closed reader", async () => {
    const sourceCancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: sourceCancel });
    const reader = stream.getReader();
    await reader.cancel();
    expect(sourceCancel).toHaveBeenCalledTimes(1);
    // A later metadata barrier cannot reopen this already-cancelled stream.
    await Promise.resolve();
    await reader.cancel();
    expect(sourceCancel).toHaveBeenCalledTimes(1);
    reader.releaseLock();
  });
  it.each([
    ["selection", "resolve"], ["selection", "reject"],
    ["unmount", "resolve"], ["unmount", "reject"]
  ] as const)("fences an old %s before metadata, observes late %s, and opens its successor", async (teardown, outcome) => {
    const old = download(1);
    const successor = download(2);
    const downloads = [old, successor];
    const files = downloads.map(value => value.descriptor);
    const published = vi.fn();
    const rejected = vi.fn();
    const signals: AbortSignal[] = [];
    const api: Pick<FilesApi, "downloadStream"> = {
      downloadStream: vi.fn((id) => downloads.find(value => value.file.id === id)!.stream)
    };
    const readFile: CollectionGateway["readFile"] = (file, options) => {
      const signal = options!.signal!;
      signals.push(signal);
      const selected: NativeFileSelection = downloads.find(value => value.file.id === file.fileId)!.file;
      const result = downloadNativeFile(api, selected, { signal, isCurrent: () => !signal.aborted })
        .then(bytes => new Blob([bytes as BlobPart]));
      void result.then(blob => published(file.fileId, blob), error => rejected(file.fileId, error));
      return result;
    };
    const store = new FileAssetStore({ readFile }); // Default budget: no eviction pressure.
    let view = render(<Workspace store={store} files={files} />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${old.file.path}` }));
    expect(screen.getByRole("status")).toHaveTextContent(`Opening ${old.file.path}`);
    expect(signals[0].aborted).toBe(false);
    expect(old.stream.locked).toBe(true);

    if (teardown === "unmount") {
      view.unmount();
      view = render(<Workspace store={store} files={files} />);
    }
    fireEvent.click(screen.getByRole("button", { name: `Select ${successor.file.path}` }));
    expect(signals[0].aborted).toBe(true);
    await waitFor(() => expect(rejected).toHaveBeenCalledWith(old.file.id, expect.objectContaining({ code: "cancelled" })));
    expect(old.cancel).not.toHaveBeenCalled();
    expect(old.sourceCancel).not.toHaveBeenCalled();
    expect(old.release).not.toHaveBeenCalled();
    expect(old.stream.locked).toBe(true);
    expect(store.get(old.descriptor).status).toBe("idle");
    expect(published).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    const version = store.getVersion();

    // Even queued provisional bytes and late metadata cannot resurrect the old
    // display/cache/error after the production effect has released its request.
    await act(async () => {
      old.controller.enqueue(new Uint8Array([1, 2]));
      if (outcome === "resolve") old.metadata.resolve(old.file);
      else {
        const failure = new Error("late metadata failure");
        old.controller.error(failure);
        old.metadata.reject(failure);
      }
    });
    await waitFor(() => expect(old.release).toHaveBeenCalledTimes(1));
    expect(old.order).toEqual([outcome === "resolve" ? "metadata" : "metadata failure", "cancel"]);
    expect(old.cancel).toHaveBeenCalledTimes(1);
    // REAL stream semantics: an errored source is not cancelled a second time.
    expect(old.sourceCancel).toHaveBeenCalledTimes(outcome === "resolve" ? 1 : 0);
    expect(old.stream.locked).toBe(false);
    expect(old.read).not.toHaveBeenCalled();
    expect(store.getVersion()).toBe(version);
    expect(store.get(old.descriptor).status).toBe("idle");
    expect(published).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByText(/Couldn’t preview/)).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: old.file.path })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(`Opening ${successor.file.path}`);

    await act(async () => {
      successor.metadata.resolve(successor.file);
      successor.controller.enqueue(new Uint8Array([3, 4]));
    });
    await waitFor(() => expect(successor.read).toHaveBeenCalledTimes(2));
    expect(URL.createObjectURL).not.toHaveBeenCalled(); // Whole stream not complete.
    await act(async () => { successor.controller.close(); });
    expect(await screen.findByRole("img", { name: successor.file.path })).toHaveAttribute("src", "blob:successor");
    expect(published).toHaveBeenCalledTimes(1);
    expect(published).toHaveBeenCalledWith(successor.file.id, expect.any(Blob));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(store.get(successor.descriptor).status).toBe("ready");
    fireEvent.click(screen.getByRole("button", { name: "Preview dialog" }));
    expect(screen.getByRole("dialog", { name: `Preview ${successor.file.path}` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close file preview" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(successor.cancel).not.toHaveBeenCalled();
    expect(successor.release).toHaveBeenCalledTimes(1);
    view.unmount();
    store.reset();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared loading request alive until its last reference releases, below cache limits", async () => {
    const current = download(1);
    const signals: AbortSignal[] = [];
    const store = new FileAssetStore({ readFile: (_file, options) => {
      const signal = options!.signal!;
      signals.push(signal);
      return downloadNativeFile({ downloadStream: () => current.stream }, current.file, {
        signal, isCurrent: () => !signal.aborted
      }).then(bytes => new Blob([bytes as BlobPart]));
    } });
    const first = store.acquire(current.descriptor);
    const second = store.acquire(current.descriptor);
    first();
    first();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    expect(store.get(current.descriptor).status).toBe("loading");
    second();
    expect(signals[0].aborted).toBe(true);
    expect(store.get(current.descriptor).status).toBe("idle");
    expect(current.cancel).not.toHaveBeenCalled();
    expect(current.sourceCancel).not.toHaveBeenCalled();
    current.metadata.resolve(current.file);
    await waitFor(() => expect(current.release).toHaveBeenCalledTimes(1));
    expect(current.cancel).toHaveBeenCalledTimes(1);
    expect(current.sourceCancel).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    store.reset();
  });
});
