import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { HttpSyncTransport } from "./index.js";
import {
  clearAuthorityPromotionCheckpoint,
  clearMirrorMarker,
  loadAuthorityPromotionCheckpoint,
  loadMirrorProfile,
  markMirror,
  readCollectionConfiguration,
  restoreCollectionConfiguration,
  retireMirrorAfterPromotion,
  saveAuthorityPromotionCheckpoint,
  setCollectionIdentity,
  updateMirrorCredentials,
  type AuthorityPromotionCheckpoint,
  type StoredMirrorProfile
} from "./device.js";
import {
  canonicalConnectOrigin,
  MirrorEnrollmentClient,
  type MirrorEnrollment
} from "./enrollment.js";
import {
  NodeMirrorStateStore,
  WritableDirectoryMirror,
  type MirrorProgress
} from "./node.js";

const TOKEN_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type AuthorityPromotionPhase =
  | "synchronizing"
  | "awaiting_approval"
  | "verifying"
  | "registering"
  | "registered"
  | "activating"
  | "completed"
  | "resuming";

export interface AuthorityPromotionResult {
  collectionId: string;
  authorityEpoch: number;
  path: string;
}

export interface AuthorityPromotionOptions {
  stateRoot?: string;
  registeredCollectionPath(collectionId: string): Promise<string | null>;
  registerCollection(path: string, collectionId: string): Promise<string>;
  validateCollection(collectionId: string): Promise<void>;
  removeCollection(collectionId: string): Promise<void>;
  onVerification?(verificationUri: string): void | Promise<void>;
  onPhase?(phase: AuthorityPromotionPhase): void;
  onProgress?(progress: MirrorProgress): void;
  pollIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface AuthorityTransfer {
  id: string;
  collection_id: string;
  replica_id: string;
  state: "requested" | "approved" | "prepared" | "completed" | "cancelled" | "expired";
  final_head: number | null;
  authority_epoch: number | null;
  manifest_digest: string | null;
  expires_at: string;
  verification_uri: string;
  local_collection_id?: string;
}

interface AuthorityTransferResponse {
  transfer: AuthorityTransfer;
  verification_uri?: string;
  expires_in?: number;
}

interface AuthorityTransferCompletion {
  status: "completed" | "waiting_for_connector";
  collection_id?: string;
  local_collection_id?: string;
  authority_epoch?: number;
  message?: string;
}

interface MirrorExchangeResponse {
  status: "paired";
  replica: {
    id: string;
    collection_id: string;
    name: string;
    mode: "read_only" | "read_write";
  };
  token: string;
  token_expires_at: string;
  sync_url: string;
}

export async function promoteMirrorAuthority(
  root: string,
  options: AuthorityPromotionOptions
): Promise<AuthorityPromotionResult> {
  const fetchRequest = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 1_500;
  const unfinished = await loadAuthorityPromotionCheckpoint(root, options.stateRoot);
  // A committed provider may already have revoked the mirror access token.
  // Resume from the durable proof without attempting ordinary token renewal.
  const stored = unfinished
    ? await loadMirrorProfile(root, options.stateRoot)
    : await currentProfile(root, options, fetchRequest);
  assertPromotableProfile(stored);
  const controlUrl = canonicalConnectOrigin(stored.profile.control_url);
  const authentication = { authorization: `Bearer ${stored.credentials.refresh_token}` };

  if (unfinished) {
    if (unfinished.collection_id !== stored.profile.collection_id) {
      throw new Error("The saved authority transfer belongs to another collection.");
    }
    options.onPhase?.("resuming");
    await setCollectionIdentity(root, unfinished.collection_id);
    await clearMirrorMarker(root, unfinished.collection_id);
    await ensurePromotedCollectionRegistered(root, unfinished.collection_id, options);
    await options.validateCollection(unfinished.collection_id);
    return completePromotion(
      root,
      controlUrl,
      authentication,
      unfinished,
      options,
      fetchRequest
    );
  }

  await assertCollectionIsNotRegistered(root, stored.profile.collection_id, options);
  options.onPhase?.("synchronizing");
  await synchronizeMirror(root, stored, options);
  const requested = await jsonRequest<AuthorityTransferResponse>(
    fetchRequest,
    `${controlUrl}/v1/mirror-pairing-requests/${encodeURIComponent(stored.profile.enrollment_id)}/authority-transfers`,
    {
      method: "POST",
      headers: { ...authentication, "content-type": "application/json" },
      body: "{}"
    }
  );
  assertTransferIdentity(requested.transfer, stored);
  const verificationUri = trustedVerificationUri(
    controlUrl,
    requested.verification_uri ?? requested.transfer.verification_uri
  );
  options.onPhase?.("awaiting_approval");
  await options.onVerification?.(verificationUri);

  const deadline = new Date(requested.transfer.expires_at).getTime();
  let prepared = requested.transfer;
  while (prepared.state !== "prepared" && Date.now() < deadline) {
    const response = await fetchRequest(
      `${controlUrl}/v1/authority-transfers/${encodeURIComponent(prepared.id)}/prepare`,
      {
        method: "POST",
        headers: { ...authentication, "content-type": "application/json" },
        body: "{}"
      }
    );
    if (response.status === 202) {
      await delay(pollIntervalMs);
      continue;
    }
    prepared = (await responseJson<AuthorityTransferResponse>(response)).transfer;
    try {
      assertTransferIdentity(prepared, stored, requested.transfer.id);
    } catch (error) {
      await fetchRequest(
        `${controlUrl}/v1/authority-transfers/${encodeURIComponent(requested.transfer.id)}`,
        { method: "DELETE", headers: authentication }
      ).catch(() => undefined);
      throw error;
    }
  }
  if (
    prepared.state !== "prepared"
    || prepared.final_head === null
    || prepared.authority_epoch === null
    || !prepared.manifest_digest
  ) {
    throw new Error("Authority transfer approval expired. Start the transfer again.");
  }

  let localRegistered = false;
  let checkpoint: Omit<AuthorityPromotionCheckpoint, "version"> | null = null;
  try {
    options.onPhase?.("verifying");
    const configuration = await currentProfile(root, options, fetchRequest);
    const mirror = writableMirror(root, configuration, options);
    await mirror.sync();
    const manifest = await mirror.authorityPromotionManifest();
    if (
      manifest.cursor !== prepared.final_head
      || manifest.digest !== prepared.manifest_digest
    ) {
      throw new Error(
        "The local folder does not exactly match the fenced collection authority."
      );
    }
    const originalConfiguration = await readCollectionConfiguration(root);
    checkpoint = {
      transfer_id: prepared.id,
      collection_id: prepared.collection_id,
      manifest_digest: prepared.manifest_digest,
      authority_epoch: prepared.authority_epoch,
      expires_at: prepared.expires_at,
      original_configuration: originalConfiguration
    };
    await saveAuthorityPromotionCheckpoint(root, checkpoint, options.stateRoot);
    await setCollectionIdentity(root, prepared.collection_id);
    await clearMirrorMarker(root, prepared.collection_id);
    options.onPhase?.("registering");
    await ensurePromotedCollectionRegistered(root, prepared.collection_id, options);
    localRegistered = true;
    await options.validateCollection(prepared.collection_id);
  } catch (error) {
    if (error instanceof LocalRegistrationOutcomeUncertainError) {
      throw error;
    }
    if (localRegistered) {
      await options.removeCollection(prepared.collection_id).catch(() => undefined);
    }
    const saved = await loadAuthorityPromotionCheckpoint(root, options.stateRoot);
    if (saved?.transfer_id === prepared.id) {
      await restoreCollectionConfiguration(root, saved.original_configuration).catch(
        () => undefined
      );
      await markMirror(root, saved.collection_id).catch(() => undefined);
      await clearAuthorityPromotionCheckpoint(root, options.stateRoot).catch(
        () => undefined
      );
    }
    await fetchRequest(
      `${controlUrl}/v1/authority-transfers/${encodeURIComponent(prepared.id)}`,
      { method: "DELETE", headers: authentication }
    ).catch(() => undefined);
    throw error;
  }

  if (!checkpoint) throw new Error("Authority transfer checkpoint was not created.");
  options.onPhase?.("registered");
  return completePromotion(
    root,
    controlUrl,
    authentication,
    checkpoint,
    options,
    fetchRequest
  );
}

export function trustedVerificationUri(controlUrl: string, value: string): string {
  const controlOrigin = new URL(canonicalConnectOrigin(controlUrl)).origin;
  const verification = new URL(value);
  if (verification.origin !== controlOrigin) {
    throw new Error("The authority returned an untrusted confirmation address.");
  }
  return verification.toString();
}

async function synchronizeMirror(
  root: string,
  stored: StoredMirrorProfile,
  options: AuthorityPromotionOptions
): Promise<void> {
  const mirror = writableMirror(root, stored, options);
  const preview = await mirror.previewInitialization();
  if (preview.collisions.length > 0) {
    throw new Error(
      `Existing files differ from the authority: ${preview.collisions.join(", ")}. `
      + "Reconcile them before moving authority."
    );
  }
  await mirror.sync();
}

function writableMirror(
  root: string,
  stored: StoredMirrorProfile,
  options: AuthorityPromotionOptions
): WritableDirectoryMirror {
  if (stored.profile.mode !== "read_write") {
    throw new Error("Authority can move only from a two-way collection mirror.");
  }
  const transport = new HttpSyncTransport(
    stored.profile.sync_url,
    stored.credentials.access_token
  );
  return new WritableDirectoryMirror(root, stored.profile.replica_id, transport, {
    stateStore: new NodeMirrorStateStore(root, options.stateRoot),
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  });
}

async function currentProfile(
  root: string,
  options: AuthorityPromotionOptions,
  fetchRequest: typeof globalThis.fetch
): Promise<StoredMirrorProfile> {
  let stored = await loadMirrorProfile(root, options.stateRoot);
  await markMirror(root, stored.profile.collection_id);
  const expiry = stored.profile.access_token_expires_at;
  const controlUrl = stored.profile.control_url;
  const enrollmentId = stored.profile.enrollment_id;
  const refreshToken = stored.credentials.refresh_token;
  if (
    controlUrl
    && enrollmentId
    && refreshToken
    && expiry
    && Date.parse(expiry) - Date.now() < TOKEN_RENEWAL_WINDOW_MS
  ) {
    const renewed = await jsonRequest<MirrorExchangeResponse>(
      fetchRequest,
      `${canonicalConnectOrigin(controlUrl)}/v1/mirror-pairing-requests/${encodeURIComponent(enrollmentId)}/renew`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${refreshToken}` }
      }
    );
    stored = await updateMirrorCredentials(
      root,
      {
        access_token: renewed.token,
        refresh_token: refreshToken
      },
      renewed.token_expires_at,
      options.stateRoot
    );
  }
  return stored;
}

function assertPromotableProfile(
  stored: StoredMirrorProfile
): asserts stored is StoredMirrorProfile & {
  profile: StoredMirrorProfile["profile"] & {
    control_url: string;
    enrollment_id: string;
  };
  credentials: StoredMirrorProfile["credentials"] & { refresh_token: string };
} {
  if (
    stored.profile.mode !== "read_write"
    || !stored.profile.control_url
    || !stored.profile.enrollment_id
    || !stored.credentials.refresh_token
  ) {
    throw new Error(
      "Authority can move only from a browser-paired, two-way full collection mirror."
    );
  }
}

function assertTransferIdentity(
  transfer: AuthorityTransfer,
  stored: StoredMirrorProfile,
  expectedTransferId?: string
): void {
  if (
    transfer.collection_id !== stored.profile.collection_id
    || transfer.replica_id !== stored.profile.replica_id
    || (expectedTransferId !== undefined && transfer.id !== expectedTransferId)
  ) {
    throw new Error(
      "The authority transfer response does not match this mirrored collection."
    );
  }
}

async function assertCollectionIsNotRegistered(
  root: string,
  collectionId: string,
  options: AuthorityPromotionOptions
): Promise<void> {
  const registeredPath = await options.registeredCollectionPath(collectionId);
  if (registeredPath === null) return;
  if (await pathsReferToSameFolder(root, registeredPath)) {
    throw new Error(
      "This folder is already registered as a local collection. "
      + "Remove that registration before moving authority."
    );
  }
  throw new Error(
    "This collection identity is already registered to another folder."
  );
}

async function ensurePromotedCollectionRegistered(
  root: string,
  collectionId: string,
  options: AuthorityPromotionOptions
): Promise<void> {
  const existingPath = await options.registeredCollectionPath(collectionId);
  if (existingPath !== null) {
    if (!(await pathsReferToSameFolder(root, existingPath))) {
      throw new Error(
        "This collection identity is already registered to another folder."
      );
    }
    return;
  }

  let registeredId: string;
  try {
    registeredId = await options.registerCollection(root, collectionId);
  } catch (registrationError) {
    let reconciledPath: string | null;
    try {
      reconciledPath = await options.registeredCollectionPath(collectionId);
    } catch {
      throw new LocalRegistrationOutcomeUncertainError(registrationError);
    }
    if (reconciledPath === null) throw registrationError;
    if (!(await pathsReferToSameFolder(root, reconciledPath))) {
      throw new Error(
        "This collection identity is already registered to another folder."
      );
    }
    return;
  }
  if (registeredId !== collectionId) {
    throw new Error("The local agent registered a different collection identity.");
  }
}

async function pathsReferToSameFolder(left: string, right: string): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    realpath(resolve(left)).catch(() => resolve(left)),
    realpath(resolve(right)).catch(() => resolve(right))
  ]);
  return canonicalLeft === canonicalRight;
}

async function completePromotion(
  root: string,
  controlUrl: string,
  authentication: { authorization: string },
  checkpoint: Omit<AuthorityPromotionCheckpoint, "version">,
  options: AuthorityPromotionOptions,
  fetchRequest: typeof globalThis.fetch
): Promise<AuthorityPromotionResult> {
  options.onPhase?.("activating");
  const deadline = new Date(checkpoint.expires_at).getTime();
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  let attempted = false;
  while (!attempted || Date.now() < deadline) {
    attempted = true;
    let response: Response;
    try {
      response = await fetchRequest(
        `${controlUrl}/v1/authority-transfers/${encodeURIComponent(checkpoint.transfer_id)}/complete`,
        {
          method: "POST",
          headers: { ...authentication, "content-type": "application/json" },
          body: JSON.stringify({ manifest_digest: checkpoint.manifest_digest })
        }
      );
    } catch {
      if (Date.now() >= deadline) break;
      await delay(pollIntervalMs);
      continue;
    }
    if (response.status === 202) {
      if (Date.now() >= deadline) break;
      await delay(pollIntervalMs);
      continue;
    }
    let completed: AuthorityTransferCompletion;
    try {
      completed = await responseJson<AuthorityTransferCompletion>(response);
    } catch (error) {
      if (
        error instanceof AuthorityPromotionRequestError
        && error.status === 409
        && ["authority_transfer_expired", "authority_transfer_inactive"].includes(error.code)
      ) {
        await rollbackMaterializedPromotion(root, checkpoint, options);
      }
      throw error;
    }
    if (
      completed.status === "completed"
      && (
        completed.collection_id !== checkpoint.collection_id
        || completed.authority_epoch !== checkpoint.authority_epoch
      )
    ) {
      throw new Error(
        "The completed authority transfer does not match the local recovery checkpoint."
      );
    }
    if (completed.status !== "completed") {
      if (Date.now() >= deadline) break;
      await delay(pollIntervalMs);
      continue;
    }
    await retireMirrorAfterPromotion(
      root,
      {
        collection_id: checkpoint.collection_id,
        authority_epoch: checkpoint.authority_epoch
      },
      options.stateRoot
    );
    options.onPhase?.("completed");
    return {
      collectionId: checkpoint.collection_id,
      authorityEpoch: checkpoint.authority_epoch,
      path: root
    };
  }
  throw new Error(
    "The local collection is ready, but activation did not finish. "
    + "Keep this computer running, then resume the authority transfer."
  );
}

async function rollbackMaterializedPromotion(
  root: string,
  checkpoint: Omit<AuthorityPromotionCheckpoint, "version">,
  options: AuthorityPromotionOptions
): Promise<void> {
  await options.removeCollection(checkpoint.collection_id);
  await restoreCollectionConfiguration(root, checkpoint.original_configuration);
  await markMirror(root, checkpoint.collection_id);
  await clearAuthorityPromotionCheckpoint(root, options.stateRoot);
}

async function jsonRequest<Result>(
  fetchRequest: typeof globalThis.fetch,
  url: string,
  init: RequestInit
): Promise<Result> {
  return responseJson<Result>(await fetchRequest(url, init));
}

async function responseJson<Result>(response: Response): Promise<Result> {
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value as { error?: { code?: string; message?: string } } | null;
    throw new AuthorityPromotionRequestError(
      response.status,
      error?.error?.code ?? "request_failed",
      error?.error?.message ?? `Request failed with status ${response.status}.`
    );
  }
  return value as Result;
}

class AuthorityPromotionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

class LocalRegistrationOutcomeUncertainError extends Error {
  constructor(cause: unknown) {
    super(
      "The local agent may have registered this collection, but its response "
      + "could not be confirmed. Keep the recovery data and resume the authority "
      + "transfer when the local agent is available.",
      { cause }
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
