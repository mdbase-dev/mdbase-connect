#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { HttpSyncTransport } from "./index.js";
import {
  DirectoryMirror,
  NodeMirrorLease,
  WritableDirectoryMirror,
  type MirrorLease,
  type MirrorProgress,
  type MirrorStatus
} from "./node.js";
import {
  assertMirror,
  loadMirrorProfile,
  markMirror,
  saveMirrorProfile,
  updateMirrorCredentials,
  type StoredMirrorProfile
} from "./device.js";
import {
  MirrorEnrollmentClient,
  canonicalConnectOrigin,
  type MirrorEnrollment
} from "./enrollment.js";
import { promoteMirrorAuthority } from "./promotion.js";

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    "sync-url": { type: "string" },
    collection: { type: "string" },
    replica: { type: "string" },
    interval: { type: "string", default: "2000" },
    writable: { type: "boolean", default: false },
    "read-only": { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
    name: { type: "string" },
    json: { type: "boolean", default: false },
    use: { type: "string" },
    decision: { type: "string" },
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
const enrollmentClient = new MirrorEnrollmentClient();

try {
  if (command === "connect") {
    await connect(root);
  } else if (command === "init") {
    await mkdir(root, { recursive: true });
    const syncUrl = required(parsed.values["sync-url"], "--sync-url");
    const collectionId = required(parsed.values.collection, "--collection");
    const replicaId = required(parsed.values.replica, "--replica");
    const token = process.env.MDBASE_CONNECT_REPLICA_TOKEN ?? await hiddenTokenPrompt();
    if (token.length < 32) throw new Error("Replica token is missing or invalid.");
    const mode = parsed.values.writable ? "read_write" : "read_only";
    const transport = new HttpSyncTransport(syncUrl, token);
    const session = await transport.openSession();
    if (session.replica_id !== replicaId || session.mode !== mode) {
      throw new Error(`Replica is not the requested ${mode.replace("_", "-")} mirror capability.`);
    }
    await markMirror(root, collectionId);
    await saveMirrorProfile(
      root,
      {
        version: 1,
        sync_url: syncUrl,
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
    const decisionId = parsed.values.decision;
    if (!recordId || decisionId === undefined || !["local", "remote"].includes(resolution ?? "")) {
      throw new Error("resolve requires an object ID, --decision, and --use local or --use remote.");
    }
    const configuration = await currentProfile(root);
    if (configuration.profile.mode !== "read_write") throw new Error("This mirror is receive-only.");
    const mirror = mirrorFor(root, configuration);
    await mirror.resolveConflict(recordId, decisionId, resolution as "local" | "remote");
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
    const acquiredLease = await new NodeMirrorLease(root).acquire();
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    try {
      process.stdout.write(`Watching collection into ${root}. Press Ctrl+C to stop.\n`);
      let lastLine = "";
      while (!stopping) {
        try {
          await sync(root, acquiredLease);
          const status = await mirrorFor(
            root,
            await currentProfile(root),
            acquiredLease
          ).status();
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
        if (!stopping) await delay(interval);
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGHUP", stop);
      await acquiredLease.release();
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function sync(root: string, lease?: MirrorLease): Promise<void> {
  const configuration = await currentProfile(root);
  await mirrorFor(root, configuration, lease).sync();
}

async function initialSync(root: string): Promise<void> {
  const configuration = await currentProfile(root);
  const mirror = mirrorFor(root, configuration);
  const preview = await mirror.previewInitialization();
  if (preview.collisions.length) {
    throw new Error(
      `Existing files differ from the authority: ${preview.collisions.join(", ")}. `
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

function mirrorFor(
  root: string,
  configuration: StoredMirrorProfile,
  lease?: MirrorLease
) {
  const transport = new HttpSyncTransport(
    configuration.profile.sync_url,
    configuration.credentials.access_token
  );
  const options = { onProgress: mirrorProgressReporter(), ...(lease ? { lease } : {}) };
  return configuration.profile.mode === "read_write"
    ? new WritableDirectoryMirror(root, configuration.profile.replica_id, transport, options)
    : new DirectoryMirror(root, configuration.profile.replica_id, transport, options);
}

function mirrorProgressReporter(): (progress: MirrorProgress) => void {
  let lastPhase: MirrorProgress["phase"] | null = null;
  let lastTotal: number | null = null;
  let lastCompleted = 0;
  return (progress) => {
    if (
      progress.phase !== lastPhase
      || progress.total !== lastTotal
      || progress.completed < lastCompleted
    ) {
      lastPhase = progress.phase;
      lastTotal = progress.total;
      lastCompleted = 0;
    }
    const interval = progress.total === null
      ? 200
      : Math.max(1, Math.ceil(progress.total / 10));
    const atUnfinishedKnownEnd = progress.total !== null
      && progress.completed === progress.total
      && !progress.done;
    if (
      atUnfinishedKnownEnd
      || (
        !progress.done
        && progress.completed !== 1
        && progress.completed - lastCompleted < interval
      )
    ) return;
    const label = progress.phase === "uploading"
      ? "Uploading local changes"
      : "Applying synchronized documents";
    const count = progress.total === null
      ? `${progress.completed} applied`
      : `${progress.completed}/${progress.total}`;
    process.stdout.write(`${label}: ${count}${progress.done ? " complete" : ""}.\n`);
    lastCompleted = progress.completed;
  };
}

async function currentProfile(root: string): Promise<StoredMirrorProfile> {
  let stored = await loadMirrorProfile(root);
  await markMirror(root, stored.profile.collection_id);
  await assertMirror(root, stored.profile.collection_id);
  const expiry = stored.profile.access_token_expires_at;
  if (
    stored.profile.control_url
    && stored.profile.enrollment_id
    && stored.credentials.refresh_token
    && expiry
    && Date.parse(expiry) - Date.now() < 24 * 60 * 60 * 1000
  ) {
    const renewed = await enrollmentClient.renew(storedEnrollment(stored));
    stored = await updateMirrorCredentials(
      root,
      {
        access_token: renewed.accessToken,
        refresh_token: stored.credentials.refresh_token
      },
      renewed.accessTokenExpiresAt
    );
  }
  return stored;
}

async function connect(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const controlUrl = canonicalConnectOrigin(required(parsed.values.server, "--server"));
  const mode = parsed.values["read-only"] ? "read_only" : "read_write";
  const name = parsed.values.name?.trim() || `${hostname() || "This computer"} mirror`;
  const enrolled = await enrollmentClient.enroll({
    controlUrl,
    mirrorName: name,
    mode,
    ...(parsed.values.collection ? { collectionId: parsed.values.collection } : {})
  }, {
    onVerification: ({ verificationUri }) => {
      process.stdout.write(`Approve this folder in your browser:\n${verificationUri}\n`);
      if (!parsed.values["no-open"]) openBrowser(verificationUri);
    }
  });
  await markMirror(root, enrolled.collectionId);
  await saveMirrorProfile(root, {
    version: 1,
    sync_url: enrolled.syncUrl,
    control_url: enrolled.controlUrl,
    collection_id: enrolled.collectionId,
    replica_id: enrolled.replicaId,
    mode: enrolled.mode,
    name: enrolled.name,
    enrollment_id: enrolled.enrollmentId,
    access_token_expires_at: enrolled.accessTokenExpiresAt
  }, {
    access_token: enrolled.accessToken,
    refresh_token: enrolled.refreshCredential
  });
  await initialSync(root);
  process.stdout.write(`Sync connected at ${root}\n`);
}

async function promote(root: string): Promise<void> {
  const result = await promoteMirrorAuthority(root, {
    registeredCollectionPath: async (collectionId) => {
      const collections = await runConnectCli(["collection", "list"]);
      return collectionPathFromControlResult(collections, collectionId);
    },
    registerCollection: async (path) => {
      const added = await runConnectCli(["collection", "add", path]);
      return collectionIdFromControlResult(added) ?? "";
    },
    validateCollection: async (collectionId) => {
      await runConnectCli(["collection", "validate", collectionId]);
    },
    removeCollection: async (collectionId) => {
      await runConnectCli(["collection", "remove", collectionId]);
    },
    onVerification: (verificationUri) => {
      process.stdout.write(
        `Confirm moving the source of truth to this computer:\n${verificationUri}\n`
      );
      if (!parsed.values["no-open"]) openBrowser(verificationUri);
    },
    onPhase: (phase) => {
      if (phase === "resuming") {
        process.stdout.write("Resuming the materialized authority handoff.\n");
      } else if (phase === "registered") {
        process.stdout.write(
          "Local collection registered. Waiting for this computer to publish it.\n"
        );
      }
    },
    onProgress: mirrorProgressReporter()
  });
  process.stdout.write(
    `Authority moved to ${result.path}. Remote writes are retired at epoch ${result.authorityEpoch}.\n`
  );
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

function collectionPathFromControlResult(
  result: unknown,
  collectionId: string
): string | null {
  if (!Array.isArray(result)) {
    throw new Error("The local mdbase connect agent returned an invalid collection list.");
  }
  const collection = result.find((candidate) =>
    candidate
    && typeof candidate === "object"
    && (candidate as Record<string, unknown>).id === collectionId
  ) as Record<string, unknown> | undefined;
  if (!collection) return null;
  if (typeof collection.path !== "string") {
    throw new Error("The local mdbase connect agent returned an invalid collection path.");
  }
  return collection.path;
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
      `  ${conflict.path ?? conflict.object_id}: ${conflict.message} (${conflict.entity}:${conflict.object_id}, decision ${conflict.decision_id})\n`
    );
  }
  for (const issue of status.local_issues) {
    process.stdout.write(`  ${issue.path}: ${issue.message}\n`);
  }
}

function statusLine(status: MirrorStatus): string {
  const lastSync = status.last_synced_at
    ? ` Last synced ${new Date(status.last_synced_at).toLocaleString()}.`
    : "";
  if (status.state === "not_initialized") return "Not synchronized yet.";
  if (status.state === "attention") {
    const count = status.conflicts.length + status.local_issues.length;
    return `Action needed for ${count} ${count === 1 ? "note" : "notes"}.${lastSync}`;
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

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for mirror initialization.`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function storedEnrollment(stored: StoredMirrorProfile): MirrorEnrollment {
  const profile = stored.profile;
  if (
    !profile.control_url
    || !profile.enrollment_id
    || !profile.access_token_expires_at
    || !stored.credentials.refresh_token
  ) {
    throw new Error("This mirror does not have renewable browser enrollment.");
  }
  return {
    controlUrl: profile.control_url,
    syncUrl: profile.sync_url,
    collectionId: profile.collection_id,
    replicaId: profile.replica_id,
    mode: profile.mode,
    name: profile.name ?? "This computer mirror",
    enrollmentId: profile.enrollment_id,
    accessToken: stored.credentials.access_token,
    refreshCredential: stored.credentials.refresh_token,
    accessTokenExpiresAt: profile.access_token_expires_at
  };
}

function usage(): void {
  process.stderr.write(`Usage:
  mdbase-mirror connect <directory> --server <connect-origin> [--collection <uuid>] [--name <device>] [--read-only] [--no-open]
  mdbase-mirror init <directory> --sync-url <authority-sync-url> --collection <uuid> --replica <uuid> [--writable]
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
