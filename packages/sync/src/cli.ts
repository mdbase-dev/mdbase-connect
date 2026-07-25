#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { HttpSyncTransport } from "./index.js";
import {
  DirectoryMirror,
  WritableDirectoryMirror,
  type MirrorStatus
} from "./node.js";
import {
  clearAuthorityPromotionCheckpoint,
  loadMirrorProfile,
  loadAuthorityPromotionCheckpoint,
  readCollectionConfiguration,
  restoreCollectionConfiguration,
  retireMirrorAfterPromotion,
  saveMirrorProfile,
  saveAuthorityPromotionCheckpoint,
  setHostedCollectionIdentity,
  updateMirrorCredentials,
  type AuthorityPromotionCheckpoint,
  type StoredMirrorProfile
} from "./device.js";

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    collection: { type: "string" },
    replica: { type: "string" },
    interval: { type: "string", default: "2000" },
    writable: { type: "boolean", default: false },
    "read-only": { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
    name: { type: "string" },
    json: { type: "boolean", default: false },
    use: { type: "string" },
    "connect-cli": { type: "string", default: "mdbase-connect" },
    help: { type: "boolean", short: "h" }
  }
});

if (parsed.values.help || parsed.positionals.length === 0) {
  usage();
  process.exit(parsed.values.help ? 0 : 1);
}

const [command, directoryValue] = parsed.positionals;
if (
  !directoryValue
  || !["connect", "init", "sync", "watch", "status", "resolve", "promote"].includes(command)
) {
  usage();
  process.exit(1);
}

const root = resolve(directoryValue);

try {
  if (command === "connect") {
    await connect(root);
  } else if (command === "init") {
    await mkdir(root, { recursive: true });
    const providerUrlValue = required(parsed.values.server, "--server");
    const collectionId = required(parsed.values.collection, "--collection");
    const replicaId = required(parsed.values.replica, "--replica");
    const token = process.env.MDBASE_CONNECT_REPLICA_TOKEN ?? await hiddenTokenPrompt();
    if (token.length < 32) throw new Error("Replica token is missing or invalid.");
    const mode = parsed.values.writable ? "read_write" : "read_only";
    const providerUrl = canonicalProviderUrl(providerUrlValue);
    const transport = new HttpSyncTransport(providerUrl, collectionId, token);
    const session = await transport.openSession();
    if (session.replica_id !== replicaId || session.mode !== mode) {
      throw new Error(`Replica is not the requested ${mode.replace("_", "-")} mirror capability.`);
    }
    await saveMirrorProfile(
      root,
      {
        version: 1,
        provider_url: providerUrl,
        collection_id: collectionId,
        replica_id: replicaId,
        mode
      },
      { access_token: token }
    );
    await initialSync(root);
    process.stdout.write(`Mirror initialized at ${root}\n`);
  } else if (command === "sync") {
    await initialSync(root);
    const configuration = await currentProfile(root);
    printStatus(await mirrorFor(root, configuration).status());
  } else if (command === "promote") {
    await promote(root);
  } else if (command === "resolve") {
    const recordId = parsed.positionals[2];
    const resolution = parsed.values.use;
    if (!recordId || !["local", "remote"].includes(resolution ?? "")) {
      throw new Error("resolve requires a record ID and --use local or --use remote.");
    }
    const configuration = await currentProfile(root);
    if (configuration.profile.mode !== "read_write") throw new Error("This mirror is receive-only.");
    const mirror = mirrorFor(root, configuration);
    await mirror.resolveConflict(recordId, resolution as "local" | "remote");
    process.stdout.write(`Conflict ${recordId} resolved using ${resolution} content.\n`);
  } else if (command === "status") {
    const configuration = await currentProfile(root);
    const status = await mirrorFor(root, configuration).status();
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      printStatus(status);
    }
  } else {
    const interval = Number(parsed.values.interval);
    if (!Number.isInteger(interval) || interval < 250) {
      throw new Error("--interval must be an integer of at least 250 milliseconds.");
    }
    process.stdout.write(`Watching hosted collection into ${root}. Press Ctrl+C to stop.\n`);
    let lastLine = "";
    while (true) {
      try {
        await sync(root);
        const status = await mirrorFor(root, await currentProfile(root)).status();
        const line = statusLine(status);
        if (line !== lastLine) {
          process.stdout.write(`${line}\n`);
          lastLine = line;
        }
      } catch (error) {
        const line = `Offline: ${error instanceof Error ? error.message : String(error)}`;
        if (line !== lastLine) {
          process.stderr.write(`${line}\n`);
          lastLine = line;
        }
      }
      await delay(interval);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function sync(root: string): Promise<void> {
  const configuration = await currentProfile(root);
  await mirrorFor(root, configuration).sync();
}

async function initialSync(root: string): Promise<void> {
  const configuration = await currentProfile(root);
  const mirror = mirrorFor(root, configuration);
  const preview = await mirror.previewInitialization();
  if (preview.collisions.length) {
    throw new Error(
      `Existing files differ from hosted Markdown: ${preview.collisions.join(", ")}. `
      + "Move or reconcile them, then run mdbase-mirror sync."
    );
  }
  if (!preview.already_initialized) {
    const changes = [
      preview.download_documents
        ? `${preview.download_documents} ${preview.download_documents === 1 ? "download" : "downloads"}`
        : null,
      preview.upload_documents
        ? `${preview.upload_documents} ${preview.upload_documents === 1 ? "upload" : "uploads"}`
        : null,
      preview.unchanged_documents
        ? `${preview.unchanged_documents} already matching`
        : null
    ].filter(Boolean).join(", ");
    process.stdout.write(`Folder check complete: ${changes || "empty collection"}.\n`);
  }
  await mirror.sync();
}

function mirrorFor(root: string, configuration: StoredMirrorProfile) {
  const transport = new HttpSyncTransport(
    configuration.profile.provider_url,
    configuration.profile.collection_id,
    configuration.credentials.access_token
  );
  return configuration.profile.mode === "read_write"
    ? new WritableDirectoryMirror(root, configuration.profile.replica_id, transport)
    : new DirectoryMirror(root, configuration.profile.replica_id, transport);
}

async function currentProfile(root: string): Promise<StoredMirrorProfile> {
  let stored = await loadMirrorProfile(root);
  const expiry = stored.profile.access_token_expires_at;
  if (
    stored.profile.control_url
    && stored.profile.enrollment_id
    && stored.credentials.refresh_token
    && expiry
    && Date.parse(expiry) - Date.now() < 24 * 60 * 60 * 1000
  ) {
    const renewed = await mirrorEnrollmentRequest<MirrorExchangeResponse>(
      stored.profile.control_url,
      stored.profile.enrollment_id,
      "renew",
      stored.credentials.refresh_token
    );
    stored = await updateMirrorCredentials(
      root,
      {
        access_token: renewed.token,
        refresh_token: stored.credentials.refresh_token
      },
      renewed.token_expires_at
    );
  }
  return stored;
}

interface MirrorPairingResponse {
  pairing_id: string;
  pairing_secret: string;
  verification_uri: string;
  expires_in: number;
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

async function connect(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const controlUrl = canonicalProviderUrl(required(parsed.values.server, "--server"));
  const mode = parsed.values["read-only"] ? "read_only" : "read_write";
  const name = parsed.values.name?.trim() || `${hostname() || "This computer"} mirror`;
  const created = await jsonRequest<MirrorPairingResponse>(
    `${controlUrl}/v1/mirror-pairing-requests`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mirror_name: name,
        mode,
        ...(parsed.values.collection ? { collection_id: parsed.values.collection } : {})
      })
    }
  );
  process.stdout.write(`Approve this folder in your browser:\n${created.verification_uri}\n`);
  if (!parsed.values["no-open"]) openBrowser(created.verification_uri);
  const deadline = Date.now() + created.expires_in * 1_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${controlUrl}/v1/mirror-pairing-requests/${encodeURIComponent(created.pairing_id)}/exchange`,
      { method: "POST", headers: { authorization: `Bearer ${created.pairing_secret}` } }
    );
    if (response.status === 202) {
      await delay(1_500);
      continue;
    }
    const exchanged = await responseJson<MirrorExchangeResponse>(response);
    await saveMirrorProfile(
      root,
      {
        version: 1,
        provider_url: canonicalProviderUrl(exchanged.sync_url),
        control_url: controlUrl,
        collection_id: exchanged.replica.collection_id,
        replica_id: exchanged.replica.id,
        mode: exchanged.replica.mode,
        name: exchanged.replica.name,
        enrollment_id: created.pairing_id,
        access_token_expires_at: exchanged.token_expires_at
      },
      {
        access_token: exchanged.token,
        refresh_token: created.pairing_secret
      }
    );
    await initialSync(root);
    process.stdout.write(`Sync connected at ${root}\n`);
    return;
  }
  throw new Error("Browser approval expired. Run the connect command again.");
}

async function promote(root: string): Promise<void> {
  const unfinished = await loadAuthorityPromotionCheckpoint(root);
  // A committed provider has already revoked the mirror access token. Resume
  // from the durable proof without attempting ordinary token renewal.
  const stored = unfinished ? await loadMirrorProfile(root) : await currentProfile(root);
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
  const controlUrl = canonicalProviderUrl(stored.profile.control_url);
  const authentication = { authorization: `Bearer ${stored.credentials.refresh_token}` };
  if (unfinished) {
    if (unfinished.collection_id !== stored.profile.collection_id) {
      throw new Error("The saved authority promotion belongs to another hosted collection.");
    }
    process.stdout.write("Resuming the materialized authority handoff.\n");
    await setHostedCollectionIdentity(root, unfinished.collection_id);
    await registerPromotedCollection(root, unfinished.collection_id);
    await completePromotion(root, controlUrl, authentication, unfinished);
    return;
  }

  await initialSync(root);
  const requested = await jsonRequest<AuthorityTransferResponse>(
    `${controlUrl}/v1/mirror-pairing-requests/${encodeURIComponent(stored.profile.enrollment_id)}/authority-transfers`,
    {
      method: "POST",
      headers: { ...authentication, "content-type": "application/json" },
      body: "{}"
    }
  );
  const verificationUri = requested.verification_uri ?? requested.transfer.verification_uri;
  process.stdout.write(
    `Confirm moving the source of truth to this computer:\n${verificationUri}\n`
  );
  if (!parsed.values["no-open"]) openBrowser(verificationUri);
  const deadline = new Date(requested.transfer.expires_at).getTime();
  let prepared = requested.transfer;
  while (prepared.state !== "prepared" && Date.now() < deadline) {
    const response = await fetch(
      `${controlUrl}/v1/authority-transfers/${encodeURIComponent(prepared.id)}/prepare`,
      { method: "POST", headers: { ...authentication, "content-type": "application/json" }, body: "{}" }
    );
    if (response.status === 202) {
      await delay(1_500);
      continue;
    }
    prepared = (await responseJson<AuthorityTransferResponse>(response)).transfer;
  }
  if (
    prepared.state !== "prepared"
    || prepared.final_head === null
    || prepared.authority_epoch === null
    || !prepared.manifest_digest
  ) {
    throw new Error("Authority transfer approval expired. Run the promote command again.");
  }

  let localRegistered = false;
  let checkpoint: Omit<AuthorityPromotionCheckpoint, "version"> | null = null;
  try {
    const configuration = await currentProfile(root);
    const mirror = mirrorFor(root, configuration);
    await mirror.sync();
    const manifest = await mirror.authorityPromotionManifest();
    if (
      manifest.cursor !== prepared.final_head
      || manifest.digest !== prepared.manifest_digest
    ) {
      throw new Error(
        "The local folder does not exactly match the fenced hosted collection."
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
    await saveAuthorityPromotionCheckpoint(root, checkpoint);
    await setHostedCollectionIdentity(root, prepared.collection_id);
    const added = await runConnectCli(["collection", "add", root]);
    const registeredId = collectionIdFromControlResult(added);
    if (registeredId !== prepared.collection_id) {
      throw new Error("The local agent registered a different collection identity.");
    }
    localRegistered = true;
    await runConnectCli(["collection", "validate", prepared.collection_id]);
  } catch (error) {
    if (localRegistered) {
      await runConnectCli(["collection", "remove", prepared.collection_id]).catch(() => undefined);
    }
    const saved = await loadAuthorityPromotionCheckpoint(root);
    if (saved?.transfer_id === prepared.id) {
      await restoreCollectionConfiguration(root, saved.original_configuration).catch(() => undefined);
      await clearAuthorityPromotionCheckpoint(root).catch(() => undefined);
    }
    await fetch(
      `${controlUrl}/v1/authority-transfers/${encodeURIComponent(prepared.id)}`,
      { method: "DELETE", headers: authentication }
    ).catch(() => undefined);
    throw error;
  }

  if (!checkpoint) throw new Error("Authority promotion checkpoint was not created.");
  process.stdout.write("Local collection registered. Waiting for this computer to publish it.\n");
  await completePromotion(root, controlUrl, authentication, checkpoint);
}

async function registerPromotedCollection(root: string, collectionId: string): Promise<void> {
  const added = await runConnectCli(["collection", "add", root]);
  const registeredId = collectionIdFromControlResult(added);
  if (registeredId !== collectionId) {
    throw new Error("The local agent registered a different collection identity.");
  }
  await runConnectCli(["collection", "validate", collectionId]);
}

async function completePromotion(
  root: string,
  controlUrl: string,
  authentication: { authorization: string },
  checkpoint: Omit<AuthorityPromotionCheckpoint, "version">
): Promise<void> {
  const deadline = new Date(checkpoint.expires_at).getTime();
  let attempted = false;
  while (!attempted || Date.now() < deadline) {
    attempted = true;
    let response: Response;
    try {
      response = await fetch(
        `${controlUrl}/v1/authority-transfers/${encodeURIComponent(checkpoint.transfer_id)}/complete`,
        {
          method: "POST",
          headers: { ...authentication, "content-type": "application/json" },
          body: JSON.stringify({ manifest_digest: checkpoint.manifest_digest })
        }
      );
    } catch {
      if (Date.now() >= deadline) break;
      await delay(2_000);
      continue;
    }
    if (response.status === 202) {
      if (Date.now() >= deadline) break;
      await delay(2_000);
      continue;
    }
    let completed: AuthorityTransferCompletion;
    try {
      completed = await responseJson<AuthorityTransferCompletion>(response);
    } catch (error) {
      if (
        error instanceof ApiRequestError
        && error.status === 409
        && ["authority_transfer_expired", "authority_transfer_inactive"].includes(error.code)
      ) {
        await rollbackMaterializedPromotion(root, checkpoint);
      }
      throw error;
    }
    if (
      completed.status !== "completed"
      || completed.collection_id !== checkpoint.collection_id
      || completed.authority_epoch !== checkpoint.authority_epoch
    ) {
      if (Date.now() >= deadline) break;
      await delay(2_000);
      continue;
    }
    await retireMirrorAfterPromotion(root, {
      collection_id: checkpoint.collection_id,
      authority_epoch: completed.authority_epoch
    });
    process.stdout.write(
      `Authority moved to ${root}. Hosted writes are retired at epoch ${completed.authority_epoch}.\n`
    );
    return;
  }
  throw new Error(
    "The local collection is ready, but activation did not finish. "
    + "Leave the folder and local agent running, then run promote again."
  );
}

async function rollbackMaterializedPromotion(
  root: string,
  checkpoint: Omit<AuthorityPromotionCheckpoint, "version">
): Promise<void> {
  await runConnectCli(["collection", "remove", checkpoint.collection_id]);
  await restoreCollectionConfiguration(root, checkpoint.original_configuration);
  await clearAuthorityPromotionCheckpoint(root);
}

async function runConnectCli(args: string[]): Promise<unknown> {
  const executable = parsed.values["connect-cli"] ?? "mdbase-connect";
  const output = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolveRun, rejectRun) => {
      const child = spawn(executable, ["--compact", ...args], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", rejectRun);
      child.on("close", (code) => resolveRun({ stdout, stderr, code }));
    }
  );
  interface LocalControlResponse {
    ok?: boolean;
    result?: unknown;
    error?: { message?: string };
  }
  let response: LocalControlResponse | null = null;
  try {
    response = JSON.parse(output.stdout) as LocalControlResponse;
  } catch {
    // The exit status and stderr below provide the actionable error.
  }
  if (output.code !== 0 || !response?.ok) {
    throw new Error(
      response?.error?.message
      ?? (output.stderr.trim() || "The local mdbase connect agent rejected the collection.")
    );
  }
  return response.result;
}

function collectionIdFromControlResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const id = (result as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

async function mirrorEnrollmentRequest<Result>(
  controlUrl: string,
  enrollmentId: string,
  action: "renew",
  refreshToken: string
): Promise<Result> {
  return jsonRequest<Result>(
    `${canonicalProviderUrl(controlUrl)}/v1/mirror-pairing-requests/${encodeURIComponent(enrollmentId)}/${action}`,
    { method: "POST", headers: { authorization: `Bearer ${refreshToken}` } }
  );
}

async function jsonRequest<Result>(url: string, init: RequestInit): Promise<Result> {
  return responseJson<Result>(await fetch(url, init));
}

async function responseJson<Result>(response: Response): Promise<Result> {
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value as { error?: { code?: string; message?: string } } | null;
    throw new ApiRequestError(
      response.status,
      error?.error?.code ?? "request_failed",
      error?.error?.message ?? `Request failed with status ${response.status}.`
    );
  }
  return value as Result;
}

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function printStatus(status: MirrorStatus): void {
  process.stdout.write(`${statusLine(status)}\n`);
  for (const conflict of status.conflicts) {
    process.stdout.write(
      `  ${conflict.path ?? conflict.record_id}: ${conflict.message} (${conflict.record_id})\n`
    );
  }
}

function statusLine(status: MirrorStatus): string {
  const lastSync = status.last_synced_at
    ? ` Last synced ${new Date(status.last_synced_at).toLocaleString()}.`
    : "";
  if (status.state === "not_initialized") return "Not synchronized yet.";
  if (status.state === "attention") {
    return `Action needed for ${status.conflicts.length} ${status.conflicts.length === 1 ? "note" : "notes"}.${lastSync}`;
  }
  if (status.state === "changes_waiting") {
    return `${status.pending} ${status.pending === 1 ? "change" : "changes"} waiting to upload.${lastSync}`;
  }
  return `Up to date.${lastSync}`;
}

async function hiddenTokenPrompt(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return new Promise((resolveToken, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolveToken(value.trim()));
      process.stdin.on("error", reject);
    });
  }
  process.stdout.write("Replica token (input hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolveToken, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
      process.stdout.write("\n");
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolveToken(value);
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
  });
}

function canonicalProviderUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Provider URL must be an origin without credentials, path, query, or fragment.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Provider URL must use HTTPS outside loopback development.");
  }
  return url.origin;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for mirror initialization.`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function usage(): void {
  process.stderr.write(`Usage:
  mdbase-mirror connect <directory> --server <connect-origin> [--collection <uuid>] [--name <device>] [--read-only] [--no-open]
  mdbase-mirror init <directory> --server <origin> --collection <uuid> --replica <uuid> [--writable]
  mdbase-mirror sync <directory>
  mdbase-mirror watch <directory> [--interval <milliseconds>]
  mdbase-mirror status <directory> [--json]
  mdbase-mirror resolve <directory> <record-id> --use <local|remote>
  mdbase-mirror promote <directory> [--no-open] [--connect-cli <path>]

The connect command opens a browser for collection approval and keeps credentials
in device-local storage. The manual init command remains available for self-hosted
automation and reads MDBASE_CONNECT_REPLICA_TOKEN when set.
The promote command moves authority from a hosted collection to this computer.
`);
}
