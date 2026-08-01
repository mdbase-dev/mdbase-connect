import type {
  AuthorityImportManifest,
  AuthorityImportRecord,
  AuthorityImportRecordPage,
  AuthorityImportSnapshot,
  CollectionFileDescriptor
} from "@mdbase-dev/connect-protocol";
import {
  AuthorityAdoptionError,
  AuthorityAdoptionOutcomeUnknownError
} from "./adoption-errors.js";
import { UUID, requiredUuid } from "./adoption-values.js";
import { SyncError } from "./sync-error.js";
import { uploadAuthorityImportFile } from "./adoption-files.js";
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
      await uploadAuthorityImportFile(this.request, prepared.import, file, source, options);
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
