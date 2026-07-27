import { SyncError } from "./index.js";

export type MirrorEnrollmentMode = "read_only" | "read_write";

export interface BeginMirrorEnrollmentInput {
  controlUrl: string;
  mirrorName: string;
  mode: MirrorEnrollmentMode;
  collectionId?: string;
}

/**
 * Short-lived approval state. The refresh credential is secret and must remain
 * in device-local storage or memory until enrollment completes.
 */
export interface MirrorEnrollmentSession {
  controlUrl: string;
  pairingId: string;
  refreshCredential: string;
  verificationUri: string;
  expiresAt: string;
  requested: {
    mirrorName: string;
    mode: MirrorEnrollmentMode;
    collectionId?: string;
  };
}

/** Public approval details safe to pass to UI and logging callbacks. */
export type MirrorEnrollmentVerification = Omit<
  MirrorEnrollmentSession,
  "refreshCredential"
>;

export interface MirrorEnrollment {
  controlUrl: string;
  syncUrl: string;
  collectionId: string;
  replicaId: string;
  mode: MirrorEnrollmentMode;
  name: string;
  enrollmentId: string;
  accessToken: string;
  refreshCredential: string;
  accessTokenExpiresAt: string;
}

export interface MirrorEnrollmentStatus {
  state: "waiting_for_approval" | "retrying";
  attempt: number;
  expiresAt: string;
  retryAt: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface WaitForMirrorEnrollmentOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onStatus?: (status: MirrorEnrollmentStatus) => void;
}

export interface EnrollMirrorOptions extends WaitForMirrorEnrollmentOptions {
  onVerification: (
    verification: MirrorEnrollmentVerification
  ) => void | Promise<void>;
}

export interface MirrorEnrollmentHttpRequest {
  url: string;
  method: "POST";
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface MirrorEnrollmentHttpResponse {
  status: number;
  body: unknown;
  retryAfterMs?: number;
}

export type MirrorEnrollmentRequester = (
  request: MirrorEnrollmentHttpRequest
) => Promise<MirrorEnrollmentHttpResponse>;

export interface MirrorEnrollmentClientOptions {
  request?: MirrorEnrollmentRequester;
  now?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

interface PairingResponse {
  pairing_id: string;
  pairing_secret: string;
  verification_uri: string;
  expires_in: number;
}

interface ExchangeResponse {
  status: "paired";
  replica: {
    id: string;
    collection_id: string;
    name: string;
    mode: MirrorEnrollmentMode;
  };
  token: string;
  token_expires_at: string;
  sync_url: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 30_000;
const MAX_ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Browser-approval enrollment for a full Markdown mirror.
 *
 * This class owns no filesystem or credential persistence. Hosts decide where
 * device-local state lives, how the verification URI is opened, and which
 * mirror filesystem/state/lease adapters to use after enrollment.
 */
export class MirrorEnrollmentClient {
  private readonly request: MirrorEnrollmentRequester;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: MirrorEnrollmentClientOptions = {}) {
    this.request = options.request ?? fetchEnrollmentRequest;
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? abortableWait;
  }

  async begin(
    input: BeginMirrorEnrollmentInput,
    options: Pick<WaitForMirrorEnrollmentOptions, "signal"> = {}
  ): Promise<MirrorEnrollmentSession> {
    throwIfAborted(options.signal);
    const controlUrl = canonicalConnectOrigin(input.controlUrl);
    const mirrorName = input.mirrorName.trim();
    if (!mirrorName || mirrorName.length > 200) {
      throw new MirrorEnrollmentError(
        "invalid_mirror_name",
        "Mirror name must contain between 1 and 200 characters."
      );
    }
    if (!["read_only", "read_write"].includes(input.mode)) {
      throw new MirrorEnrollmentError(
        "invalid_mirror_mode",
        "Mirror mode must be read-only or read-write."
      );
    }
    if (input.collectionId !== undefined && !UUID.test(input.collectionId)) {
      throw new MirrorEnrollmentError(
        "invalid_collection_id",
        "Collection ID must be a UUID."
      );
    }
    let response: MirrorEnrollmentHttpResponse;
    try {
      response = await this.request({
        url: `${controlUrl}/v1/mirror-pairing-requests`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          mirror_name: mirrorName,
          mode: input.mode,
          ...(input.collectionId ? { collection_id: input.collectionId } : {})
        },
        ...(options.signal ? { signal: options.signal } : {})
      });
    } catch {
      throwIfAborted(options.signal);
      throw unreachableError();
    }
    const pairing = responseValue<PairingResponse>(response, 201);
    if (
      !isRecord(pairing)
      || !UUID.test(string(pairing.pairing_id))
      || !secret(pairing.pairing_secret)
      || !positiveSafeInteger(pairing.expires_in)
      || Number(pairing.expires_in) * 1_000 > MAX_ENROLLMENT_TTL_MS
    ) {
      throw invalidResponse("Connect returned an invalid mirror approval.");
    }
    const verificationUri = trustedVerificationUri(
      controlUrl,
      string(pairing.verification_uri),
      string(pairing.pairing_id)
    );
    return {
      controlUrl,
      pairingId: string(pairing.pairing_id),
      refreshCredential: string(pairing.pairing_secret),
      verificationUri,
      expiresAt: new Date(this.now() + Number(pairing.expires_in) * 1_000).toISOString(),
      requested: {
        mirrorName,
        mode: input.mode,
        ...(input.collectionId ? { collectionId: input.collectionId } : {})
      }
    };
  }

  async enroll(
    input: BeginMirrorEnrollmentInput,
    options: EnrollMirrorOptions
  ): Promise<MirrorEnrollment> {
    const session = await this.begin(input, options);
    const { refreshCredential: _secret, ...verification } = session;
    await options.onVerification(verification);
    return this.waitForApproval(session, options);
  }

  async waitForApproval(
    session: MirrorEnrollmentSession,
    options: WaitForMirrorEnrollmentOptions = {}
  ): Promise<MirrorEnrollment> {
    validateSession(session, this.now());
    const pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
    const deadline = Date.parse(session.expiresAt);
    let attempt = 0;
    while (this.now() < deadline) {
      throwIfAborted(options.signal);
      attempt += 1;
      let response: MirrorEnrollmentHttpResponse;
      try {
        response = await this.request({
          url: enrollmentActionUrl(session.controlUrl, session.pairingId, "exchange"),
          method: "POST",
          headers: { authorization: `Bearer ${session.refreshCredential}` },
          ...(options.signal ? { signal: options.signal } : {})
        });
      } catch (error) {
        throwIfAborted(options.signal);
        const retryAt = await this.retry(
          deadline,
          pollIntervalMs,
          options,
          attempt,
          networkStatus(error)
        );
        if (retryAt === null) break;
        continue;
      }

      if (response.status === 200) {
        return parseEnrollment(session, response.body, {
          mirrorName: session.requested.mirrorName
        });
      }
      if (response.status === 202) {
        if (!isRecord(response.body) || response.body.status !== "pending") {
          throw invalidResponse("Connect returned an invalid pending mirror approval.");
        }
        const retryAt = await this.retry(
          deadline,
          response.retryAfterMs ?? pollIntervalMs,
          options,
          attempt
        );
        if (retryAt === null) break;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const error = responseError(response);
        const retryAt = await this.retry(
          deadline,
          response.retryAfterMs ?? pollIntervalMs,
          options,
          attempt,
          { code: error.code, message: error.message }
        );
        if (retryAt === null) break;
        continue;
      }
      throw responseError(response);
    }
    throw new MirrorEnrollmentError(
      "mirror_enrollment_expired",
      "Mirror approval expired before it was completed."
    );
  }

  async renew(
    enrollment: MirrorEnrollment,
    options: Pick<WaitForMirrorEnrollmentOptions, "signal"> = {}
  ): Promise<MirrorEnrollment> {
    validateEnrollment(enrollment);
    throwIfAborted(options.signal);
    let response: MirrorEnrollmentHttpResponse;
    try {
      response = await this.request({
        url: enrollmentActionUrl(enrollment.controlUrl, enrollment.enrollmentId, "renew"),
        method: "POST",
        headers: { authorization: `Bearer ${enrollment.refreshCredential}` },
        ...(options.signal ? { signal: options.signal } : {})
      });
    } catch {
      throwIfAborted(options.signal);
      throw unreachableError();
    }
    const session: MirrorEnrollmentSession = {
      controlUrl: enrollment.controlUrl,
      pairingId: enrollment.enrollmentId,
      refreshCredential: enrollment.refreshCredential,
      verificationUri: `${enrollment.controlUrl}/mirror/${enrollment.enrollmentId}`,
      expiresAt: new Date(this.now() + 60_000).toISOString(),
      requested: {
        mirrorName: enrollment.name,
        mode: enrollment.mode,
        collectionId: enrollment.collectionId
      }
    };
    return parseEnrollment(session, responseValue<ExchangeResponse>(response, 200), {
      replicaId: enrollment.replicaId
    });
  }

  private async retry(
    deadline: number,
    requestedDelay: number,
    options: WaitForMirrorEnrollmentOptions,
    attempt: number,
    error?: MirrorEnrollmentStatus["error"]
  ): Promise<string | null> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return null;
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
    return retryAt;
  }
}

export class MirrorEnrollmentError extends SyncError {
  constructor(
    code: string,
    message: string,
    readonly status?: number
  ) {
    super(code, message);
    this.name = "MirrorEnrollmentError";
  }
}

export function canonicalConnectOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MirrorEnrollmentError(
      "invalid_connect_url",
      "Connect URL must be an absolute HTTPS origin."
    );
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new MirrorEnrollmentError(
      "invalid_connect_url",
      "Connect URL must be an origin without credentials, path, query, or fragment."
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new MirrorEnrollmentError(
      "invalid_connect_url",
      "Connect URL must use HTTPS outside loopback development."
    );
  }
  return url.origin;
}

async function fetchEnrollmentRequest(
  request: MirrorEnrollmentHttpRequest
): Promise<MirrorEnrollmentHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    ...(request.signal ? { signal: request.signal } : {})
  });
  const body = await response.json().catch(() => null);
  const retryAfter = response.headers.get("retry-after");
  return {
    status: response.status,
    body,
    ...(retryAfter === null ? {} : { retryAfterMs: retryAfterMilliseconds(retryAfter) })
  };
}

function parseEnrollment(
  session: MirrorEnrollmentSession,
  value: unknown,
  expected: { mirrorName?: string; replicaId?: string }
): MirrorEnrollment {
  if (!isRecord(value) || value.status !== "paired" || !isRecord(value.replica)) {
    throw invalidResponse("Connect returned an invalid mirror enrollment.");
  }
  const replica = value.replica;
  const replicaId = string(replica.id);
  const collectionId = string(replica.collection_id);
  const name = string(replica.name).trim();
  const mode = replica.mode;
  const token = string(value.token);
  const tokenExpiresAt = string(value.token_expires_at);
  if (
    !UUID.test(replicaId)
    || !UUID.test(collectionId)
    || !name
    || !["read_only", "read_write"].includes(String(mode))
    || !secret(token)
    || !validInstant(tokenExpiresAt)
  ) {
    throw invalidResponse("Connect returned invalid mirror credentials.");
  }
  if (mode !== session.requested.mode) {
    throw invalidResponse("Connect returned a mirror with a different access mode.");
  }
  if (
    session.requested.collectionId
    && collectionId !== session.requested.collectionId
  ) {
    throw invalidResponse("Connect returned a different collection.");
  }
  if (expected.mirrorName !== undefined && name !== expected.mirrorName) {
    throw invalidResponse("Connect returned a mirror with a different name.");
  }
  if (expected.replicaId !== undefined && replicaId !== expected.replicaId) {
    throw invalidResponse("Connect returned a different mirror replica.");
  }
  let syncUrl: string;
  try {
    syncUrl = canonicalSyncUrl(string(value.sync_url), collectionId);
  } catch {
    throw invalidResponse("Connect returned an invalid authority sync URL.");
  }
  return {
    controlUrl: canonicalConnectOrigin(session.controlUrl),
    syncUrl,
    collectionId,
    replicaId,
    mode: mode as MirrorEnrollmentMode,
    name,
    enrollmentId: session.pairingId,
    accessToken: token,
    refreshCredential: session.refreshCredential,
    accessTokenExpiresAt: tokenExpiresAt
  };
}

function validateSession(session: MirrorEnrollmentSession, now: number): void {
  canonicalConnectOrigin(session.controlUrl);
  const expiresAt = Date.parse(session.expiresAt);
  if (
    !UUID.test(session.pairingId)
    || !secret(session.refreshCredential)
    || !Number.isFinite(expiresAt)
    || expiresAt - now > MAX_ENROLLMENT_TTL_MS
    || !session.requested.mirrorName.trim()
    || session.requested.mirrorName.length > 200
    || !["read_only", "read_write"].includes(session.requested.mode)
    || (
      session.requested.collectionId !== undefined
      && !UUID.test(session.requested.collectionId)
    )
  ) {
    throw new MirrorEnrollmentError(
      "invalid_mirror_enrollment_session",
      "Mirror enrollment session is invalid."
    );
  }
  trustedVerificationUri(
    session.controlUrl,
    session.verificationUri,
    session.pairingId
  );
}

function validateEnrollment(enrollment: MirrorEnrollment): void {
  canonicalConnectOrigin(enrollment.controlUrl);
  canonicalSyncUrl(enrollment.syncUrl, enrollment.collectionId);
  if (
    !UUID.test(enrollment.collectionId)
    || !UUID.test(enrollment.replicaId)
    || !UUID.test(enrollment.enrollmentId)
    || !secret(enrollment.accessToken)
    || !secret(enrollment.refreshCredential)
    || !validInstant(enrollment.accessTokenExpiresAt)
    || !enrollment.name.trim()
    || enrollment.name.length > 200
    || !["read_only", "read_write"].includes(enrollment.mode)
  ) {
    throw new MirrorEnrollmentError(
      "invalid_mirror_enrollment",
      "Stored mirror enrollment is invalid."
    );
  }
}

function canonicalSyncUrl(value: string, collectionId: string): string {
  const url = new URL(value);
  const expectedPath = `/v1/authorities/${encodeURIComponent(collectionId)}/sync`;
  if (
    !(
      url.protocol === "https:"
      || (
        url.protocol === "http:"
        && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
      )
    )
    || url.username
    || url.password
    || url.pathname.replace(/\/$/, "") !== expectedPath
    || url.search
    || url.hash
  ) {
    throw new Error("invalid sync URL");
  }
  return `${url.origin}${expectedPath}`;
}

function trustedVerificationUri(
  controlUrl: string,
  value: string,
  pairingId: string
): string {
  let verification: URL;
  try {
    verification = new URL(value);
  } catch {
    throw invalidResponse("Connect returned an invalid mirror verification URI.");
  }
  const expected = new URL(`/mirror/${encodeURIComponent(pairingId)}`, controlUrl);
  if (
    verification.origin !== expected.origin
    || verification.pathname !== expected.pathname
    || verification.search
    || verification.hash
    || verification.username
    || verification.password
  ) {
    throw invalidResponse("Connect returned an untrusted mirror verification URI.");
  }
  return verification.href;
}

function enrollmentActionUrl(
  controlUrl: string,
  enrollmentId: string,
  action: "exchange" | "renew"
): string {
  return `${canonicalConnectOrigin(controlUrl)}/v1/mirror-pairing-requests/`
    + `${encodeURIComponent(enrollmentId)}/${action}`;
}

function responseValue<Value>(
  response: MirrorEnrollmentHttpResponse,
  expectedStatus: number
): Value {
  if (response.status !== expectedStatus) throw responseError(response);
  return response.body as Value;
}

function responseError(response: MirrorEnrollmentHttpResponse): MirrorEnrollmentError {
  const envelope = isRecord(response.body) && isRecord(response.body.error)
    ? response.body.error
    : {};
  return new MirrorEnrollmentError(
    string(envelope.code) || "mirror_enrollment_request_failed",
    string(envelope.message) || `Mirror enrollment request failed with status ${response.status}.`,
    response.status
  );
}

function invalidResponse(message: string): MirrorEnrollmentError {
  return new MirrorEnrollmentError("invalid_mirror_enrollment_response", message);
}

function networkStatus(
  _error: unknown
): NonNullable<MirrorEnrollmentStatus["error"]> {
  return {
    code: "mirror_enrollment_unreachable",
    message: "Connect could not be reached for mirror enrollment."
  };
}

function unreachableError(): MirrorEnrollmentError {
  const status = networkStatus(undefined);
  return new MirrorEnrollmentError(status.code, status.message);
}

function boundedPollInterval(value = DEFAULT_POLL_INTERVAL_MS): number {
  if (!Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.round(value)));
}

function retryAfterMilliseconds(value: string): number {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const instant = Date.parse(value);
  return Number.isFinite(instant)
    ? Math.max(0, instant - Date.now())
    : DEFAULT_POLL_INTERVAL_MS;
}

function abortableWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const aborted = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", aborted);
      reject(new MirrorEnrollmentError(
        "mirror_enrollment_cancelled",
        "Mirror enrollment was cancelled."
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
    throw new MirrorEnrollmentError(
      "mirror_enrollment_cancelled",
      "Mirror enrollment was cancelled."
    );
  }
}

function validInstant(value: string): boolean {
  const instant = Date.parse(value);
  return Number.isFinite(instant);
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
