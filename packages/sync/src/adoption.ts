import type {
  AuthorityImportManifest,
  AuthorityImportRecord,
  AuthorityImportRecordPage,
  AuthorityImportSnapshot,
  CollectionFileDescriptor,
  CommitFileUploadReceipt,
  FileTransferSession,
  PreparedFilePart,
  UploadedFilePart
} from "@mdbase-dev/connect-protocol";
import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  AuthorityAdoptionError,
  AuthorityAdoptionOutcomeUnknownError
} from "./adoption-errors.js";
import { UUID, requiredUuid } from "./adoption-values.js";
import { SyncError } from "./sync-error.js";
import {
  canonicalConnectOrigin,
  type MirrorEnrollmentSession
} from "./enrollment.js";

export {
  AuthorityAdoptionError,
  AuthorityAdoptionOutcomeUnknownError
} from "./adoption-errors.js";
export {
  buildPortableAuthoritySnapshot,
  portableRecordId,
  type BuildPortableAuthoritySnapshotInput,
  type PortableAuthorityRecord,
  type PortableAuthorityResource
} from "./adoption-snapshot.js";

export interface BeginAuthorityAdoptionInput {
  controlUrl: string;
  collectionId: string;
  displayName: string;
  sourceName: string;
  retainMirror?: boolean;
  mirrorName?: string;
}

export interface AuthorityAdoptionSession {
  controlUrl: string;
  adoptionId: string;
  credential: string;
  verificationUri: string;
  expiresAt: string;
  requested: {
    collectionId: string;
    displayName: string;
    sourceName: string;
    retainMirror: boolean;
    mirrorName?: string;
  };
}

export type AuthorityAdoptionVerification = Omit<AuthorityAdoptionSession, "credential">;

export interface AuthorityAdoptionView {
  id: string;
  collection_id: string;
  display_name: string;
  source_name: string;
  retain_mirror: boolean;
  mirror_name: string | null;
  state:
    | "requested"
    | "approved"
    | "prepared"
    | "activating"
    | "completed"
    | "cancelled"
    | "expired";
  authority_epoch: number;
  final_head: number | null;
  manifest_digest: string | null;
  source_revision: string | null;
  expires_at: string;
}

export interface AuthorityImportCapability {
  import_id: string;
  manifest_url: string;
  records_url: string;
  files_url: string;
  finalize_url: string;
  access_token: string;
}

export type AuthorityImportFileSource = Blob | ArrayBuffer | ArrayBufferView;

export interface UploadAuthoritySnapshotOptions {
  signal?: AbortSignal;
  /** Resolve bytes lazily so large files can remain backed by application storage. */
  fileSource?: (
    file: CollectionFileDescriptor
  ) => AuthorityImportFileSource | Promise<AuthorityImportFileSource>;
  onFileProgress?: (progress: {
    file: CollectionFileDescriptor;
    transferredBytes: number;
    totalBytes: number;
  }) => void;
}

export interface PreparedAuthorityAdoption {
  status: "ready";
  adoption: AuthorityAdoptionView;
  import: AuthorityImportCapability;
  staged: {
    state: "receiving" | "uploaded";
    manifest_digest: string | null;
    source_revision: string | null;
    source_head: number | null;
  };
}

export interface CompletedAuthorityAdoption {
  status: "completed";
  adoption: AuthorityAdoptionView;
}

export interface AuthorityAdoptionStatus {
  state: "waiting_for_approval" | "retrying";
  attempt: number;
  expiresAt: string;
  retryAt: string;
  error?: { code: string; message: string };
}

export interface AuthorityAdoptionRequest {
  url: string;
  method: "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** Send body verbatim instead of JSON encoding it. Used only for presigned object storage. */
  rawBody?: boolean;
  signal?: AbortSignal;
}

export interface AuthorityAdoptionResponse {
  status: number;
  body: unknown;
  retryAfterMs?: number;
  headers?: Record<string, string>;
}

export type AuthorityAdoptionRequester = (
  request: AuthorityAdoptionRequest
) => Promise<AuthorityAdoptionResponse>;

export interface AuthorityAdoptionClientOptions {
  request?: AuthorityAdoptionRequester;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface WaitForAuthorityAdoptionOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onStatus?: (status: AuthorityAdoptionStatus) => void;
}

export interface StartAuthorityAdoptionOptions extends WaitForAuthorityAdoptionOptions {
  onVerification(
    verification: AuthorityAdoptionVerification
  ): void | Promise<void>;
}

interface BeginResponse {
  adoption_id: string;
  adoption_secret: string;
  verification_uri: string;
  expires_in: number;
}

interface ExchangeResponse {
  status: "ready" | "activating" | "completed";
  adoption: AuthorityAdoptionView;
  import?: AuthorityImportCapability;
  staged?: PreparedAuthorityAdoption["staged"];
}


const SHA256_REVISION = /^sha256:[a-f0-9]{64}$/;
const MANIFEST_DIGEST = /^[a-f0-9]{64}$/;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const MAX_ADOPTION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PAGE_RECORDS = 200;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_FILE_PARTS = 10_000;
const utf8 = new TextEncoder();

/**
 * Portable local-collection adoption.
 *
 * The local source is not registered as a Connect network authority. It
 * supplies a canonical snapshot, remains writable until the host takes its
 * final write fence, and becomes a mirror (or archive) only after completion.
 */
export class AuthorityAdoptionClient {
  private readonly request: AuthorityAdoptionRequester;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: AuthorityAdoptionClientOptions = {}) {
    this.request = options.request ?? fetchAdoptionRequest;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? abortableWait;
  }

  async begin(
    input: BeginAuthorityAdoptionInput,
    options: Pick<WaitForAuthorityAdoptionOptions, "signal"> = {}
  ): Promise<AuthorityAdoptionSession> {
    throwIfAborted(options.signal);
    const controlUrl = canonicalConnectOrigin(input.controlUrl);
    const collectionId = requiredUuid(input.collectionId, "Collection ID");
    const displayName = requiredName(input.displayName, "Collection name");
    const sourceName = requiredName(input.sourceName, "Source name");
    const retainMirror = input.retainMirror ?? true;
    const mirrorName = retainMirror
      ? requiredName(input.mirrorName ?? sourceName, "Mirror name")
      : undefined;
    let response: AuthorityAdoptionResponse;
    try {
      response = await this.request({
        url: `${controlUrl}/v1/authority-adoptions`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          collection_id: collectionId,
          display_name: displayName,
          source_name: sourceName,
          retain_mirror: retainMirror,
          ...(mirrorName ? { mirror_name: mirrorName } : {})
        },
        ...(options.signal ? { signal: options.signal } : {})
      });
    } catch {
      throwIfAborted(options.signal);
      throw unreachableError();
    }
    const begun = responseValue<BeginResponse>(response, 201);
    if (
      !isRecord(begun)
      || !UUID.test(string(begun.adoption_id))
      || !secret(begun.adoption_secret)
      || !positiveSafeInteger(begun.expires_in)
      || Number(begun.expires_in) * 1_000 > MAX_ADOPTION_TTL_MS
    ) {
      throw invalidResponse("Connect returned an invalid collection adoption request.");
    }
    const verificationUri = trustedVerificationUri(
      controlUrl,
      string(begun.verification_uri),
      string(begun.adoption_id)
    );
    return {
      controlUrl,
      adoptionId: string(begun.adoption_id),
      credential: string(begun.adoption_secret),
      verificationUri,
      expiresAt: new Date(this.now() + Number(begun.expires_in) * 1_000).toISOString(),
      requested: {
        collectionId,
        displayName,
        sourceName,
        retainMirror,
        ...(mirrorName ? { mirrorName } : {})
      }
    };
  }

  async start(
    input: BeginAuthorityAdoptionInput,
    options: StartAuthorityAdoptionOptions
  ): Promise<{ session: AuthorityAdoptionSession; prepared: PreparedAuthorityAdoption }> {
    const session = await this.begin(input, options);
    const { credential: _credential, ...verification } = session;
    await options.onVerification(verification);
    return {
      session,
      prepared: await this.waitForApproval(session, options)
    };
  }

  async waitForApproval(
    session: AuthorityAdoptionSession,
    options: WaitForAuthorityAdoptionOptions = {}
  ): Promise<PreparedAuthorityAdoption> {
    validateSession(session, this.now());
    const pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
    const deadline = Date.parse(session.expiresAt);
    let attempt = 0;
    while (this.now() < deadline) {
      throwIfAborted(options.signal);
      attempt += 1;
      let response: AuthorityAdoptionResponse;
      try {
        response = await this.request({
          url: adoptionActionUrl(session, "exchange"),
          method: "POST",
          headers: {
            authorization: `Bearer ${session.credential}`,
            "content-type": "application/json"
          },
          body: {},
          ...(options.signal ? { signal: options.signal } : {})
        });
      } catch (error) {
        throwIfAborted(options.signal);
        if (!await this.retry(deadline, pollIntervalMs, attempt, options, networkStatus(error))) {
          break;
        }
        continue;
      }
      if (response.status === 200) {
        const exchanged = parseExchange(session, response.body);
        if (exchanged.status === "ready") return exchanged;
        if (exchanged.status === "completed") {
          throw new AuthorityAdoptionError(
            "authority_adoption_already_completed",
            "Collection adoption has already completed.",
            200
          );
        }
        throw new AuthorityAdoptionOutcomeUnknownError(
          "Hosted authority activation has started. Resume completion with the fenced snapshot."
        );
      }
      if (response.status === 202) {
        if (!isRecord(response.body) || response.body.status !== "pending") {
          throw invalidResponse("Connect returned an invalid pending adoption response.");
        }
        if (!await this.retry(
          deadline,
          response.retryAfterMs ?? pollIntervalMs,
          attempt,
          options
        )) break;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const status = adoptionResponseError(response);
        if (!await this.retry(
          deadline,
          response.retryAfterMs ?? pollIntervalMs,
          attempt,
          options,
          { code: status.code, message: status.message }
        )) break;
        continue;
      }
      throw adoptionResponseError(response);
    }
    throw new AuthorityAdoptionError(
      "authority_adoption_expired",
      "Collection adoption approval expired before upload began."
    );
  }

  async exchange(
    session: AuthorityAdoptionSession,
    options: Pick<WaitForAuthorityAdoptionOptions, "signal"> = {}
  ): Promise<PreparedAuthorityAdoption | CompletedAuthorityAdoption | {
    status: "activating";
    adoption: AuthorityAdoptionView;
  }> {
    validateSession(session, this.now(), true);
    const response = await this.controlRequest(session, "exchange", "POST", {}, options.signal);
    if (response.status === 202) {
      throw new AuthorityAdoptionError(
        "authority_adoption_pending",
        "Collection adoption is still awaiting approval.",
        202
      );
    }
    if (response.status !== 200) throw adoptionResponseError(response);
    return parseExchange(session, response.body);
  }

  async uploadSnapshot(
    session: AuthorityAdoptionSession,
    prepared: PreparedAuthorityAdoption,
    snapshot: AuthorityImportSnapshot,
    options: UploadAuthoritySnapshotOptions = {}
  ): Promise<void> {
    validateSession(session, this.now(), true);
    validatePrepared(session, prepared);
    validateSnapshot(session, snapshot);
    const manifest: AuthorityImportManifest = {
      protocol_version: 1,
      collection_id: snapshot.collection_id,
      source_head: snapshot.source_head,
      source_revision: snapshot.source_revision,
      manifest_digest: snapshot.manifest_digest,
      resources: snapshot.resources,
      record_count: snapshot.records.length,
      file_count: snapshot.files.length,
      files: snapshot.files
    };
    await this.importRequest(
      prepared.import.manifest_url,
      "PUT",
      prepared.import.access_token,
      manifest,
      options.signal
    );
    let pageNumber = 0;
    let page: AuthorityImportRecord[] = [];
    let pageBytes = 0;
    for (const record of snapshot.records) {
      const bytes = utf8.encode(JSON.stringify(record)).length;
      if (bytes > MAX_PAGE_BYTES) {
        throw new AuthorityAdoptionError(
          "authority_adoption_record_too_large",
          `Record ${record.path} is too large to adopt.`
        );
      }
      if (
        page.length > 0
        && (page.length === MAX_PAGE_RECORDS || pageBytes + bytes > MAX_PAGE_BYTES)
      ) {
        await this.uploadPage(prepared.import, pageNumber, page, options.signal);
        pageNumber += 1;
        page = [];
        pageBytes = 0;
      }
      page.push(record);
      pageBytes += bytes;
    }
    if (page.length > 0) {
      await this.uploadPage(prepared.import, pageNumber, page, options.signal);
    }
    for (const file of snapshot.files) {
      if (!options.fileSource) {
        throw new AuthorityAdoptionError(
          "authority_adoption_file_source_required",
          `File bytes are required to adopt ${file.path}.`
        );
      }
      const source = await options.fileSource(file);
      await this.uploadFile(prepared.import, file, source, options);
    }
    await this.importRequest(
      prepared.import.finalize_url,
      "POST",
      prepared.import.access_token,
      undefined,
      options.signal
    );
  }

  async complete(
    session: AuthorityAdoptionSession,
    snapshot: AuthorityImportSnapshot,
    options: Pick<WaitForAuthorityAdoptionOptions, "signal"> = {}
  ): Promise<CompletedAuthorityAdoption> {
    validateSession(session, this.now(), true);
    validateSnapshot(session, snapshot);
    let response: AuthorityAdoptionResponse;
    try {
      response = await this.controlRequest(
        session,
        "complete",
        "POST",
        {
          manifest_digest: snapshot.manifest_digest,
          source_revision: snapshot.source_revision,
          source_head: snapshot.source_head
        },
        options.signal
      );
    } catch (error) {
      throwIfAborted(options.signal);
      throw new AuthorityAdoptionOutcomeUnknownError(
        "Connect could not confirm whether hosted authority activated.",
        { cause: error }
      );
    }
    if (response.status >= 500) {
      throw new AuthorityAdoptionOutcomeUnknownError(
        "Connect could not confirm whether hosted authority activated."
      );
    }
    if (response.status !== 200) throw adoptionResponseError(response);
    const value = response.body;
    if (!isRecord(value) || value.status !== "completed") {
      throw invalidResponse("Connect returned an invalid adoption completion.");
    }
    const adoption = parseAdoption(session, value.adoption);
    if (
      adoption.state !== "completed"
      || adoption.manifest_digest !== snapshot.manifest_digest
      || adoption.source_revision !== snapshot.source_revision
      || adoption.final_head !== snapshot.source_head
    ) {
      throw invalidResponse("Connect completed a different adoption snapshot.");
    }
    return { status: "completed", adoption };
  }

  async cancel(
    session: AuthorityAdoptionSession,
    options: Pick<WaitForAuthorityAdoptionOptions, "signal"> = {}
  ): Promise<void> {
    validateSession(session, this.now(), true);
    const response = await this.controlRequest(
      session,
      undefined,
      "DELETE",
      undefined,
      options.signal
    );
    if (response.status !== 200) throw adoptionResponseError(response);
  }

  mirrorEnrollmentSession(
    session: AuthorityAdoptionSession,
    completed: CompletedAuthorityAdoption
  ): MirrorEnrollmentSession | null {
    validateSession(session, this.now(), true);
    if (
      completed.status !== "completed"
      || completed.adoption.collection_id !== session.requested.collectionId
    ) {
      throw invalidResponse("Completed adoption does not belong to this session.");
    }
    if (!session.requested.retainMirror) return null;
    return {
      controlUrl: session.controlUrl,
      pairingId: session.adoptionId,
      refreshCredential: session.credential,
      verificationUri: `${session.controlUrl}/mirror/${session.adoptionId}`,
      expiresAt: new Date(this.now() + MAX_ADOPTION_TTL_MS).toISOString(),
      requested: {
        mirrorName: session.requested.mirrorName ?? session.requested.sourceName,
        mode: "read_write",
        collectionId: session.requested.collectionId
      }
    };
  }

  private async uploadFile(
    capability: AuthorityImportCapability,
    file: CollectionFileDescriptor,
    source: AuthorityImportFileSource,
    options: UploadAuthoritySnapshotOptions
  ): Promise<void> {
    const blob = authorityFileBlob(source, file.media_type);
    if (blob.size !== file.size || await blobDigest(blob, options.signal) !== file.content_digest) {
      throw new AuthorityAdoptionError(
        "authority_adoption_file_changed",
        `File bytes no longer match the fenced snapshot for ${file.path}.`
      );
    }
    const transferId = authorityImportTransferId(capability.import_id, file);
    const session = await this.importJson<FileTransferSession>(
      `${capability.files_url}/uploads`,
      "POST",
      capability.access_token,
      {
        protocol_version: 1,
        type: "open_authority_import_file_upload",
        transfer_id: transferId,
        file_id: file.file_id
      },
      options.signal
    );
    validateImportFileSession(session, transferId, file.size);
    if (session.strategy.kind !== "object_put" && session.strategy.kind !== "object_multipart") {
      throw invalidResponse("Connect returned an incompatible authority import file strategy.");
    }
    const partSize = session.strategy.kind === "object_put"
      ? Math.max(1, file.size)
      : session.strategy.part_size;
    const partCount = session.strategy.kind === "object_put"
      ? 1
      : Math.ceil(file.size / partSize);
    if (partCount > MAX_FILE_PARTS) {
      throw invalidResponse("Authority import returned too many file parts.");
    }
    if (session.received.length === partCount) {
      const committed = await this.tryCommitImportFile(capability, file, transferId, [], options.signal);
      if (committed) return;
    }
    const parts: UploadedFilePart[] = [];
    let transferredBytes = 0;
    for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
      throwIfAborted(options.signal);
      const offset = partIndex * partSize;
      const contentLength = Math.min(partSize, Math.max(0, file.size - offset));
      const prepared = await this.importJson<PreparedFilePart>(
        `${capability.files_url}/uploads/${encodeURIComponent(transferId)}/parts`,
        "POST",
        capability.access_token,
        {
          protocol_version: 1,
          type: "prepare_file_upload_part",
          transfer_id: transferId,
          part_number: partIndex + 1,
          content_length: contentLength
        },
        options.signal
      );
      validatePreparedImportPart(prepared, transferId, partIndex, offset, contentLength);
      const response = await this.objectRequest(
        prepared,
        blob.slice(offset, offset + contentLength),
        options.signal
      );
      if (session.strategy.kind === "object_multipart") {
        const etag = response.headers?.etag;
        if (!etag) throw invalidResponse("Object storage omitted a multipart ETag.");
        parts.push({ part_number: partIndex + 1, etag });
      }
      transferredBytes += contentLength;
      options.onFileProgress?.({ file, transferredBytes, totalBytes: file.size });
    }
    const committed = await this.tryCommitImportFile(
      capability,
      file,
      transferId,
      parts,
      options.signal
    );
    if (!committed) {
      throw new AuthorityAdoptionError(
        "authority_adoption_file_upload_incomplete",
        `Connect could not commit ${file.path}.`
      );
    }
  }

  private async tryCommitImportFile(
    capability: AuthorityImportCapability,
    file: CollectionFileDescriptor,
    transferId: string,
    parts: UploadedFilePart[],
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const receipt = await this.importJson<CommitFileUploadReceipt>(
        `${capability.files_url}/uploads/${encodeURIComponent(transferId)}/commit`,
        "POST",
        capability.access_token,
        {
          protocol_version: 1,
          type: "commit_file_upload",
          transfer_id: transferId,
          ...(parts.length > 0 ? { parts } : {})
        },
        signal
      );
      if (
        receipt.protocol_version !== 1
        || receipt.type !== "file_upload_committed"
        || receipt.transfer_id !== transferId
        || !sameFileDescriptor(receipt.file, file)
      ) {
        throw invalidResponse("Connect returned an invalid authority import file receipt.");
      }
      return true;
    } catch (error) {
      if (
        parts.length === 0
        && error instanceof AuthorityAdoptionError
        && error.code === "file_upload_incomplete"
      ) return false;
      throw error;
    }
  }

  private async importJson<Result>(
    url: string,
    method: "POST" | "PUT",
    accessToken: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<Result> {
    let response: AuthorityAdoptionResponse;
    try {
      response = await this.request({
        url,
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body,
        ...(signal ? { signal } : {})
      });
    } catch {
      throwIfAborted(signal);
      throw unreachableError();
    }
    if (response.status < 200 || response.status >= 300) {
      throw adoptionResponseError(response);
    }
    return response.body as Result;
  }

  private async objectRequest(
    prepared: PreparedFilePart,
    body: Blob,
    signal?: AbortSignal
  ): Promise<AuthorityAdoptionResponse> {
    validatePreparedObjectUrl(prepared.url);
    const headers = safePreparedHeaders(prepared.headers);
    let response: AuthorityAdoptionResponse;
    try {
      response = await this.request({
        url: prepared.url,
        method: "PUT",
        headers,
        body,
        rawBody: true,
        ...(signal ? { signal } : {})
      });
    } catch {
      throwIfAborted(signal);
      throw unreachableError();
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AuthorityAdoptionError(
        "authority_adoption_object_upload_failed",
        "Object storage rejected an authority import file part.",
        response.status
      );
    }
    return response;
  }

  private async uploadPage(
    capability: AuthorityImportCapability,
    page: number,
    records: AuthorityImportRecord[],
    signal?: AbortSignal
  ): Promise<void> {
    const body: AuthorityImportRecordPage = {
      protocol_version: 1,
      page,
      records
    };
    await this.importRequest(
      capability.records_url,
      "PUT",
      capability.access_token,
      body,
      signal
    );
  }

  private async importRequest(
    url: string,
    method: "POST" | "PUT",
    accessToken: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<void> {
    let response: AuthorityAdoptionResponse;
    try {
      response = await this.request({
        url,
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {})
      });
    } catch {
      throwIfAborted(signal);
      throw unreachableError();
    }
    if (response.status < 200 || response.status >= 300) {
      throw adoptionResponseError(response);
    }
  }

  private controlRequest(
    session: AuthorityAdoptionSession,
    action: "exchange" | "complete" | undefined,
    method: "POST" | "DELETE",
    body?: unknown,
    signal?: AbortSignal
  ): Promise<AuthorityAdoptionResponse> {
    return this.request({
      url: adoptionActionUrl(session, action),
      method,
      headers: {
        authorization: `Bearer ${session.credential}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {})
    });
  }

  private async retry(
    deadline: number,
    requestedDelay: number,
    attempt: number,
    options: WaitForAuthorityAdoptionOptions,
    error?: AuthorityAdoptionStatus["error"]
  ): Promise<boolean> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return false;
    const delay = Math.min(boundedPollInterval(requestedDelay), remaining);
    const retryAt = new Date(this.now() + delay).toISOString();
    options.onStatus?.({
      state: error ? "retrying" : "waiting_for_approval",
      attempt,
      expiresAt: new Date(deadline).toISOString(),
      retryAt,
      ...(error ? { error } : {})
    });
    await this.wait(delay, options.signal);
    return true;
  }
}


function validateSession(
  session: AuthorityAdoptionSession,
  now: number,
  allowExpired = false
): void {
  canonicalConnectOrigin(session.controlUrl);
  const expiresAt = Date.parse(session.expiresAt);
  if (
    !UUID.test(session.adoptionId)
    || !secret(session.credential)
    || !Number.isFinite(expiresAt)
    || expiresAt - now > MAX_ADOPTION_TTL_MS
    || (!allowExpired && expiresAt <= now)
    || !UUID.test(session.requested.collectionId)
    || !session.requested.displayName.trim()
    || !session.requested.sourceName.trim()
  ) {
    throw new AuthorityAdoptionError(
      "invalid_authority_adoption_session",
      "Stored collection adoption state is invalid."
    );
  }
  trustedVerificationUri(session.controlUrl, session.verificationUri, session.adoptionId);
}

function validatePrepared(
  session: AuthorityAdoptionSession,
  prepared: PreparedAuthorityAdoption
): void {
  if (
    prepared.status !== "ready"
    || prepared.adoption.id !== session.adoptionId
    || prepared.adoption.collection_id !== session.requested.collectionId
  ) {
    throw invalidResponse("Prepared adoption does not belong to this session.");
  }
  const capability = prepared.import;
  if (!UUID.test(capability.import_id) || !secret(capability.access_token)) {
    throw invalidResponse("Connect returned an invalid authority import capability.");
  }
  const endpoints = [
    [capability.manifest_url, "manifest"],
    [capability.records_url, "records"],
    [capability.files_url, "files"],
    [capability.finalize_url, "finalize"]
  ] as const;
  let origin: string | undefined;
  for (const [value, suffix] of endpoints) {
    const parsed = trustedProviderUrl(value, capability.import_id, suffix);
    if (!parsed || (origin !== undefined && parsed.origin !== origin)) {
      throw invalidResponse("Connect returned an invalid authority import capability.");
    }
    origin = parsed.origin;
  }
}

function validateSnapshot(
  session: AuthorityAdoptionSession,
  snapshot: AuthorityImportSnapshot
): void {
  if (
    snapshot.protocol_version !== 1
    || snapshot.collection_id !== session.requested.collectionId
    || !Number.isSafeInteger(snapshot.source_head)
    || snapshot.source_head < 0
    || !SHA256_REVISION.test(snapshot.source_revision)
    || !MANIFEST_DIGEST.test(snapshot.manifest_digest)
    || snapshot.resources.documents?.length === 0
    || !Array.isArray(snapshot.files)
  ) {
    throw new AuthorityAdoptionError(
      "invalid_authority_snapshot",
      "Authority snapshot does not belong to this adoption."
    );
  }
}

function authorityFileBlob(source: AuthorityImportFileSource, mediaType?: string): Blob {
  if (source instanceof Blob) return source;
  if (source instanceof ArrayBuffer) return new Blob([source], { type: mediaType });
  const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  return new Blob([bytes], { type: mediaType });
}

async function blobDigest(blob: Blob, signal?: AbortSignal): Promise<`sha256:${string}`> {
  const digest = sha256.create();
  const reader = blob.stream().getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      digest.update(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return `sha256:${bytesToHex(digest.digest())}`;
}

function authorityImportTransferId(importId: string, file: CollectionFileDescriptor): string {
  const namespace = uuidBytes(importId);
  const name = utf8.encode(
    `mdbase-authority-import-file-v1\0${file.file_id}\0${file.revision}\0${file.content_digest}`
  );
  const digest = sha1(new Uint8Array([...namespace, ...name])).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(digest);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidBytes(value: string): Uint8Array {
  if (!UUID.test(value)) throw invalidResponse("Authority import ID is invalid.");
  return Uint8Array.from(
    value.replaceAll("-", "").match(/../g)!.map((byte) => Number.parseInt(byte, 16))
  );
}

function validateImportFileSession(
  session: FileTransferSession,
  transferId: string,
  size: number
): void {
  const strategy = session?.strategy;
  if (
    session?.protocol_version !== 1
    || session.type !== "file_transfer"
    || session.transfer_id !== transferId
    || session.direction !== "upload"
    || session.protection !== "transport_tls"
    || session.total_size !== size
    || !Array.isArray(session.received)
    || !strategy
    || !["object_put", "object_multipart"].includes(strategy.kind)
    || (strategy.kind === "object_multipart"
      && (!Number.isSafeInteger(strategy.part_size) || strategy.part_size <= 0))
  ) {
    throw invalidResponse("Connect returned an invalid authority import file session.");
  }
  if (strategy.kind !== "object_put" && strategy.kind !== "object_multipart") {
    throw invalidResponse("Connect returned an invalid authority import file strategy.");
  }
  const partSize = strategy.kind === "object_put" ? Math.max(1, size) : strategy.part_size;
  const partCount = strategy.kind === "object_put" ? 1 : Math.ceil(size / partSize);
  const received = new Set(session.received);
  if (
    received.size !== session.received.length
    || session.received.some((part) => !Number.isSafeInteger(part) || part < 0 || part >= partCount)
  ) {
    throw invalidResponse("Connect returned invalid authority import file progress.");
  }
}

function validatePreparedImportPart(
  part: PreparedFilePart,
  transferId: string,
  partIndex: number,
  offset: number,
  contentLength: number
): void {
  if (
    part?.protocol_version !== 1
    || part.type !== "file_part"
    || part.transfer_id !== transferId
    || part.part_index !== partIndex
    || part.offset !== offset
    || part.content_length !== contentLength
    || part.method.toUpperCase() !== "PUT"
    || !Number.isFinite(Date.parse(part.expires_at))
    || !isRecord(part.headers)
  ) {
    throw invalidResponse("Connect returned an invalid prepared authority import file part.");
  }
}

function validatePreparedObjectUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse("Connect returned an invalid object storage URL.");
  }
  if (
    (url.protocol !== "https:"
      && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)))
    || url.username
    || url.password
    || url.hash
  ) {
    throw invalidResponse("Connect returned an unsafe object storage URL.");
  }
}

function safePreparedHeaders(input: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (["authorization", "cookie", "host", "proxy-authorization"].includes(name.toLowerCase())) {
      throw invalidResponse("Connect returned unsafe object storage headers.");
    }
    if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
      throw invalidResponse("Connect returned invalid object storage headers.");
    }
    headers[name] = value;
  }
  return headers;
}

function sameFileDescriptor(
  left: CollectionFileDescriptor,
  right: CollectionFileDescriptor
): boolean {
  return left.file_id === right.file_id
    && left.path === right.path
    && left.revision === right.revision
    && left.content_digest === right.content_digest
    && left.size === right.size
    && left.media_type === right.media_type
    && left.media_class === right.media_class
    && left.modified_at === right.modified_at;
}

function parseExchange(
  session: AuthorityAdoptionSession,
  value: unknown
): PreparedAuthorityAdoption | CompletedAuthorityAdoption | {
  status: "activating";
  adoption: AuthorityAdoptionView;
} {
  if (!isRecord(value) || !["ready", "activating", "completed"].includes(string(value.status))) {
    throw invalidResponse("Connect returned an invalid adoption exchange.");
  }
  const adoption = parseAdoption(session, value.adoption);
  if (value.status === "completed") return { status: "completed", adoption };
  if (value.status === "activating") return { status: "activating", adoption };
  if (!isRecord(value.import) || !isRecord(value.staged)) {
    throw invalidResponse("Connect omitted the authority import capability.");
  }
  const capability = value.import;
  const staged = value.staged;
  const parsed: PreparedAuthorityAdoption = {
    status: "ready",
    adoption,
    import: {
      import_id: string(capability.import_id),
      manifest_url: string(capability.manifest_url),
      records_url: string(capability.records_url),
      files_url: string(capability.files_url),
      finalize_url: string(capability.finalize_url),
      access_token: string(capability.access_token)
    },
    staged: {
      state: staged.state as "receiving" | "uploaded",
      manifest_digest: nullableString(staged.manifest_digest),
      source_revision: nullableString(staged.source_revision),
      source_head: nullableSafeInteger(staged.source_head)
    }
  };
  validatePrepared(session, parsed);
  if (!["receiving", "uploaded"].includes(parsed.staged.state)) {
    throw invalidResponse("Connect returned an invalid staged import state.");
  }
  return parsed;
}

function parseAdoption(
  session: AuthorityAdoptionSession,
  value: unknown
): AuthorityAdoptionView {
  if (!isRecord(value)) throw invalidResponse("Connect omitted collection adoption state.");
  const adoption = value as unknown as AuthorityAdoptionView;
  if (
    adoption.id !== session.adoptionId
    || adoption.collection_id !== session.requested.collectionId
    || !["requested", "approved", "prepared", "activating", "completed", "cancelled", "expired"]
      .includes(adoption.state)
    || !Number.isSafeInteger(adoption.authority_epoch)
    || adoption.authority_epoch < 2
    || !validInstant(adoption.expires_at)
  ) {
    throw invalidResponse("Connect returned invalid collection adoption state.");
  }
  return adoption;
}

function trustedProviderUrl(
  value: string,
  importId: string,
  suffix: "manifest" | "records" | "files" | "finalize"
): URL | null {
  try {
    const url = new URL(value);
    const trusted = (
      (
        url.protocol === "https:"
        || (
          url.protocol === "http:"
          && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
        )
      )
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === `/v1/authority-imports/${importId}/${suffix}`
    );
    return trusted ? url : null;
  } catch {
    return null;
  }
}

function trustedVerificationUri(
  controlUrl: string,
  value: string,
  adoptionId: string
): string {
  let verification: URL;
  try {
    verification = new URL(value);
  } catch {
    throw invalidResponse("Connect returned an invalid adoption verification URI.");
  }
  const expected = new URL(`/adopt/${encodeURIComponent(adoptionId)}`, controlUrl);
  if (
    verification.origin !== expected.origin
    || verification.pathname !== expected.pathname
    || verification.search
    || verification.hash
    || verification.username
    || verification.password
  ) {
    throw invalidResponse("Connect returned an untrusted adoption verification URI.");
  }
  return verification.href;
}

function adoptionActionUrl(
  session: AuthorityAdoptionSession,
  action: "exchange" | "complete" | undefined
): string {
  const suffix = action ? `/${action}` : "";
  return `${canonicalConnectOrigin(session.controlUrl)}/v1/authority-adoptions/`
    + `${encodeURIComponent(session.adoptionId)}${suffix}`;
}



function requiredName(value: string, label: string): string {
  const name = value.trim();
  if (!name || name.length > 200) {
    throw new AuthorityAdoptionError(
      "invalid_authority_adoption",
      `${label} must contain between 1 and 200 characters.`
    );
  }
  return name;
}

function responseValue<Value>(
  response: AuthorityAdoptionResponse,
  expectedStatus: number
): Value {
  if (response.status !== expectedStatus) throw adoptionResponseError(response);
  return response.body as Value;
}

function adoptionResponseError(
  response: AuthorityAdoptionResponse
): AuthorityAdoptionError {
  const envelope = isRecord(response.body) && isRecord(response.body.error)
    ? response.body.error
    : {};
  return new AuthorityAdoptionError(
    string(envelope.code) || "authority_adoption_request_failed",
    string(envelope.message)
      || `Collection adoption request failed with status ${response.status}.`,
    response.status
  );
}

function invalidResponse(message: string): AuthorityAdoptionError {
  return new AuthorityAdoptionError(
    "invalid_authority_adoption_response",
    message
  );
}

function networkStatus(
  _error: unknown
): NonNullable<AuthorityAdoptionStatus["error"]> {
  return {
    code: "authority_adoption_unreachable",
    message: "Connect could not be reached for collection adoption."
  };
}

function unreachableError(): AuthorityAdoptionError {
  const status = networkStatus(undefined);
  return new AuthorityAdoptionError(status.code, status.message);
}

function boundedPollInterval(value = DEFAULT_POLL_INTERVAL_MS): number {
  if (!Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(30_000, Math.max(250, Math.round(value)));
}

function abortableWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const aborted = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", aborted);
      reject(new AuthorityAdoptionError(
        "authority_adoption_cancelled",
        "Collection adoption was cancelled."
      ));
    };
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AuthorityAdoptionError(
      "authority_adoption_cancelled",
      "Collection adoption was cancelled."
    );
  }
}

async function fetchAdoptionRequest(
  request: AuthorityAdoptionRequest
): Promise<AuthorityAdoptionResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    redirect: "error",
    ...(request.body === undefined
      ? {}
      : { body: request.rawBody ? request.body as BodyInit : JSON.stringify(request.body) }),
    ...(request.signal ? { signal: request.signal } : {})
  });
  const body = await response.json().catch(() => ({}));
  const retryAfter = response.headers.get("retry-after");
  return {
    status: response.status,
    body,
    headers: Object.fromEntries(response.headers.entries()),
    ...(retryAfter ? { retryAfterMs: retryAfterMilliseconds(retryAfter) } : {})
  };
}

function retryAfterMilliseconds(value: string): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const instant = Date.parse(value);
  return Number.isFinite(instant)
    ? Math.max(0, instant - Date.now())
    : DEFAULT_POLL_INTERVAL_MS;
}

function validInstant(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function nullableSafeInteger(value: unknown): number | null {
  return value === null
    ? null
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : Number.NaN;
}

function positiveSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function secret(value: unknown): boolean {
  return typeof value === "string" && value.length >= 16;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
