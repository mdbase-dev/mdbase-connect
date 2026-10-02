import type { CollectionFileDescriptor as WireDescriptor, FileCapability, FileStat, ListFilesPage } from "@mdbase-dev/connect-protocol";
import { abortableDelay } from "./async.js";
import { authorityCapabilities } from "./authority-features.js";
import { connectError, MdbaseConnectError } from "./errors.js";
import { normalizeFileError, SHA256_DIGEST, throwIfAborted, validPageSize } from "./file-transfer-internals.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import { ALL_CONNECT_PROBLEM_CODES, captureConnectOutcome, type ConnectOutcome } from "./outcomes.js";
import { createRequestBudget, withRequestBudget } from "./request-budget.js";

// Match files.v1's UUID format (including nil), not crypto transfer-version rules.
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface CollectionFileDescriptor {
  fileId: string;
  path: string;
  revision: string;
  contentDigest: `sha256:${string}`;
  size: number;
  mediaType?: string;
  mediaClass: import("@mdbase-dev/connect-protocol").FileMediaClass;
  modifiedAt: string;
}

export interface MdbaseFileListOptions extends ConnectRequestOptions {
  folder?: string;
  pageSize?: number;
  /** Called while a cold or changed collection builds its verified binary index. */
  onIndexing?: () => void;
}

export type MdbaseFileStatTarget = { path: string; fileId?: never } | { path?: never; fileId: string };

export type FileControlRequest = <Result>(
  method: "GET" | "POST" | "DELETE", path?: string, input?: unknown, signal?: AbortSignal
) => Promise<Result>;

export async function filePage(
  request: FileControlRequest, query: URLSearchParams, signal?: AbortSignal, onIndexing?: () => void
): Promise<ListFilesPage> {
  while (true) {
    throwIfAborted(signal);
    try {
      const page = await request<ListFilesPage>("GET", `?${query}`, undefined, signal);
      if (page?.protocol_version !== 1 || page.type !== "files_page" || !Array.isArray(page.files)
          || (page.next !== undefined && (typeof page.next !== "string" || !page.next))) {
        throw connectError("invalid_operation_response", "The authority returned an invalid file page.");
      }
      authorityCapabilities(page.authority_capabilities);
      return page;
    } catch (error) {
      const normalized = normalizeFileError(error);
      if (normalized.code !== "file_index_warming") throw normalized;
      onIndexing?.();
      await abortableDelay(500, signal);
    }
  }
}

export async function* listFiles(
  capability: () => FileCapability | null, request: FileControlRequest,
  options: MdbaseFileListOptions, timeoutMs: number | null
): AsyncGenerator<CollectionFileDescriptor> {
  const budget = createRequestBudget(options, timeoutMs);
  try {
    requireList(capability());
    let after: string | undefined;
    do {
      const query = new URLSearchParams({
        protocol_version: "1",
        ...(options.folder ? { folder: options.folder } : {}),
        ...(after ? { after } : {}),
        ...(options.pageSize ? { limit: String(validPageSize(options.pageSize)) } : {})
      });
      const page = await filePage(request, query, budget.signal, options.onIndexing);
      for (const file of page.files) {
        throwIfAborted(budget.signal);
        yield clientFileDescriptor(file);
      }
      after = page.next;
    } while (after);
  } finally { budget.dispose(); }
}

export function statFile(
  capability: () => FileCapability | null, request: FileControlRequest,
  supports: (id: string, options?: ConnectRequestOptions) => Promise<ConnectOutcome<boolean>>,
  list: (options: MdbaseFileListOptions) => AsyncIterable<CollectionFileDescriptor>,
  target: MdbaseFileStatTarget, options: ConnectRequestOptions, timeoutMs: number | null
): Promise<ConnectOutcome<CollectionFileDescriptor | null>> {
  return captureConnectOutcome(() => withRequestBudget(options, timeoutMs, async budget => {
    requireList(capability());
    if (!target || typeof target !== "object" || Object.keys(target).length !== 1
        || !(Object.hasOwn(target, "path") && typeof target.path === "string"
          || Object.hasOwn(target, "fileId") && typeof target.fileId === "string" && FILE_ID.test(target.fileId))) {
      throw connectError("invalid_request", "File stat requires exactly one path or UUID fileId.");
    }
    // Collection-relative wire syntax only. Eligibility, exclusion rules and
    // filesystem access remain authority-owned, including during legacy listing.
    if (target.path !== undefined && (target.path.length > 1024 || target.path.includes("\\")
        || target.path.split("/").some(part => !part || part.startsWith(".")))) {
      throw connectError("invalid_request", "File stat requires a collection-relative file path.");
    }
    const supported = await supports("files-stat-v1", { signal: budget.signal, timeoutMs: null });
    if (!supported.ok) throw new MdbaseConnectError(supported.problem);
    throwIfAborted(budget.signal);
    if (supported.value) {
      const result = await request<FileStat>("POST", "stat", {
        protocol_version: 1, type: "stat_file",
        ...(target.path !== undefined ? { path: target.path } : { file_id: target.fileId })
      }, budget.signal);
      if (result?.protocol_version !== 1 || result.type !== "file_stat" || result.file === undefined) {
        throw connectError("invalid_operation_response", "The authority returned an invalid file stat.");
      }
      if (result.file === null) return null;
      const file = clientFileDescriptor(result.file);
      if (target.path !== undefined ? portableKey(file.path) !== portableKey(target.path)
          : file.fileId.toLowerCase() !== target.fileId!.toLowerCase()) {
        throw connectError("invalid_operation_response", "The authority returned a stat for a different file.");
      }
      return file;
    }
    // Consumers: Writer/Reader/editor/TaskNotes against late-updated authorities.
    // Remove once the minimum files-stat authority, all consumer pins, and N-1
    // rollback/connection-cache windows close. Listing is not point-cost or atomic.
    const folder = target.path?.includes("/") ? target.path.slice(0, target.path.lastIndexOf("/")) : undefined;
    for await (const file of list({ folder, signal: budget.signal, timeoutMs: null })) {
      throwIfAborted(budget.signal);
      if (target.path !== undefined
          ? portableKey(file.path) === portableKey(target.path)
          : file.fileId.toLowerCase() === target.fileId!.toLowerCase()) return file;
    }
    throwIfAborted(budget.signal);
    return null;
  }), ALL_CONNECT_PROBLEM_CODES);
}

function requireList(capability: FileCapability | null): void {
  if (!capability?.actions.includes("list")) throw connectError("not_authorized", "This connection is not authorized to list files.");
}

// File protocol portable identity comparison, not collection eligibility validation.
function portableKey(path: string): string {
  // Match Connect's NFC + per-Unicode-scalar lowercase + NFC key, not JS's
  // context-sensitive whole-string lowercase (e.g. Greek final sigma).
  return Array.from(path.normalize("NFC"), scalar => scalar.toLowerCase()).join("").normalize("NFC");
}

export function clientFileDescriptor(file: WireDescriptor): CollectionFileDescriptor {
  if (!file || typeof file.file_id !== "string" || !FILE_ID.test(file.file_id)
      || typeof file.path !== "string" || typeof file.revision !== "string"
      || typeof file.content_digest !== "string" || !SHA256_DIGEST.test(file.content_digest)
      || !Number.isSafeInteger(file.size) || file.size < 0
      || !["image", "audio", "video", "pdf", "other"].includes(file.media_class)
      || typeof file.modified_at !== "string"
      || (file.media_type !== undefined && typeof file.media_type !== "string")) {
    throw connectError("invalid_operation_response", "The authority returned an invalid file descriptor.");
  }
  return {
    fileId: file.file_id, path: file.path, revision: file.revision,
    contentDigest: file.content_digest, size: file.size,
    ...(file.media_type ? { mediaType: file.media_type } : {}),
    mediaClass: file.media_class, modifiedAt: file.modified_at
  };
}
