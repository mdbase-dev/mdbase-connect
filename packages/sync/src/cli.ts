#!/usr/bin/env node

import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
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
  type StoredMirrorProfile
} from "./device.js";
import { WatchBackoff, type MirrorApplyResult } from "./mirror-plan.js";

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    "sync-url": { type: "string" },
    collection: { type: "string" },
    replica: { type: "string" },
    interval: { type: "string", default: "2000" },
    writable: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    use: { type: "string" },
    decision: { type: "string" },
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
  || !["init", "sync", "watch", "status", "resolve"].includes(command)
) {
  usage();
  process.exit(1);
}

const root = resolve(directoryValue);

try {
  if (command === "init") {
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
    const backoff = new WatchBackoff(interval);
    let stopping = false;
    let wake: (() => void) | undefined;
    const stop = () => {
      stopping = true;
      wake?.();
    };
    // A local change ends a backoff early, so new edits sync promptly.
    const changes = watchLocalChanges(root, () => {
      if (backoff.reset()) wake?.();
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    try {
      process.stdout.write(`Watching collection into ${root}. Press Ctrl+C to stop.\n`);
      let lastLine = "";
      while (!stopping) {
        let result: MirrorApplyResult | undefined;
        try {
          result = await sync(root, acquiredLease);
          const status = await mirrorFor(
            root,
            await currentProfile(root),
            acquiredLease
          ).status();
          // A blocked or refused pass returns rather than throws, so say why.
          const blocked = (result.status === "failed" || result.failure?.action_id) && result.failure
            ? `. Blocked: ${result.failure.code}: ${result.failure.message}`
            : "";
          const line = `${statusLine(status)}${blocked}`;
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
        const wait = backoff.next(result);
        if (!stopping) {
          await new Promise<void>((resolveWait) => {
            const timer = setTimeout(resolveWait, wait);
            wake = () => {
              clearTimeout(timer);
              resolveWait();
            };
          });
          wake = undefined;
        }
      }
    } finally {
      changes?.close();
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

async function sync(root: string, lease?: MirrorLease): Promise<MirrorApplyResult> {
  const configuration = await currentProfile(root);
  return mirrorFor(root, configuration, lease).sync();
}

/**
 * Report edits under `root`, ignoring dot-directories (app state such as
 * `.obsidian`) and the mirror's own temporary files. Not on Linux, where a
 * recursive watch walks the tree and spends one shared inotify watch per entry;
 * there the backoff alone limits retries to five minutes apart.
 */
function watchLocalChanges(root: string, onChange: () => void): FSWatcher | undefined {
  if (process.platform === "linux") return undefined;
  try {
    const watcher = watch(root, { recursive: true }, (_event, name) => {
      if (name && String(name).split(/[\\/]/u).some((segment) => segment.startsWith("."))) return;
      onChange();
    });
    watcher.on("error", () => watcher.close());
    return watcher;
  } catch {
    return undefined;
  }
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
  const stored = await loadMirrorProfile(root);
  await markMirror(root, stored.profile.collection_id);
  await assertMirror(root, stored.profile.collection_id);
  return stored;
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

function usage(): void {
  process.stderr.write(`Usage:
  mdbase-mirror init <directory> --sync-url <authority-sync-url> --collection <uuid> --replica <uuid> [--writable]
  mdbase-mirror sync <directory>
  mdbase-mirror watch <directory> [--interval <milliseconds>]
  mdbase-mirror status <directory> [--json]
  mdbase-mirror resolve <directory> <record-id> --use <local|remote>

The init command keeps credentials in device-local storage and reads
MDBASE_CONNECT_REPLICA_TOKEN when set.
`);
}
