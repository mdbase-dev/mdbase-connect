#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { HttpSyncTransport } from "./index.js";
import { DirectoryMirror, WritableDirectoryMirror } from "./node.js";

interface MirrorConfiguration {
  protocol_version: 1;
  provider_url: string;
  collection_id: string;
  replica_id: string;
  replica_token: string;
  mode: "read_only" | "read_write";
}

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    collection: { type: "string" },
    replica: { type: "string" },
    interval: { type: "string", default: "2000" },
    writable: { type: "boolean", default: false },
    use: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

if (parsed.values.help || parsed.positionals.length === 0) {
  usage();
  process.exit(parsed.values.help ? 0 : 1);
}

const [command, directoryValue] = parsed.positionals;
if (!directoryValue || !["init", "sync", "watch", "resolve"].includes(command)) {
  usage();
  process.exit(1);
}

const root = resolve(directoryValue);

try {
  if (command === "init") {
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
    await mkdir(join(root, ".mdbase"), { recursive: true });
    const configPath = await configurationPath(root);
    await atomicWrite(
      configPath,
      `${JSON.stringify({
        protocol_version: 1,
        provider_url: providerUrl,
        collection_id: collectionId,
        replica_id: replicaId,
        replica_token: token,
        mode
      } satisfies MirrorConfiguration, null, 2)}\n`
    );
    await sync(root);
    process.stdout.write(`Mirror initialized at ${root}\n`);
  } else if (command === "sync") {
    await sync(root);
    process.stdout.write("Mirror is up to date.\n");
  } else if (command === "resolve") {
    const recordId = parsed.positionals[2];
    const resolution = parsed.values.use;
    if (!recordId || !["local", "remote"].includes(resolution ?? "")) {
      throw new Error("resolve requires a record ID and --use local or --use remote.");
    }
    const configuration = await loadConfiguration(root);
    if (configuration.mode !== "read_write") throw new Error("This mirror is receive-only.");
    const mirror = mirrorFor(root, configuration);
    await mirror.resolveConflict(recordId, resolution as "local" | "remote");
    process.stdout.write(`Conflict ${recordId} resolved using ${resolution} content.\n`);
  } else {
    const interval = Number(parsed.values.interval);
    if (!Number.isInteger(interval) || interval < 250) {
      throw new Error("--interval must be an integer of at least 250 milliseconds.");
    }
    process.stdout.write(`Watching hosted collection into ${root}. Press Ctrl+C to stop.\n`);
    while (true) {
      await sync(root);
      await delay(interval);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function sync(root: string): Promise<void> {
  const configuration = await loadConfiguration(root);
  await mirrorFor(root, configuration).sync();
}

function mirrorFor(root: string, configuration: MirrorConfiguration) {
  const transport = new HttpSyncTransport(
    configuration.provider_url,
    configuration.collection_id,
    configuration.replica_token
  );
  return configuration.mode === "read_write"
    ? new WritableDirectoryMirror(root, configuration.replica_id, transport)
    : new DirectoryMirror(root, configuration.replica_id, transport);
}

async function loadConfiguration(root: string): Promise<MirrorConfiguration> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(await configurationPath(root), "utf8"));
  } catch {
    throw new Error(`Mirror configuration is missing or invalid. Run mdbase-mirror init ${root} first.`);
  }
  if (!value || typeof value !== "object") throw new Error("Mirror configuration is invalid.");
  const config = value as Partial<MirrorConfiguration>;
  if (
    config.protocol_version !== 1
    || typeof config.provider_url !== "string"
    || typeof config.collection_id !== "string"
    || typeof config.replica_id !== "string"
    || typeof config.replica_token !== "string"
  ) {
    throw new Error("Mirror configuration is invalid.");
  }
  const mode = config.mode ?? "read_only";
  if (!(["read_only", "read_write"] as const).includes(mode)) {
    throw new Error("Mirror configuration mode is invalid.");
  }
  return {
    ...config,
    mode,
    provider_url: canonicalProviderUrl(config.provider_url)
  } as MirrorConfiguration;
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

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

async function configurationPath(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const metadataDirectory = join(canonicalRoot, ".mdbase");
  const metadata = await lstat(metadataDirectory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Mirror metadata must be an ordinary directory inside the mirror root.");
  }
  const path = join(metadataDirectory, "connect-mirror.json");
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error("Mirror configuration cannot be a symbolic link.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return path;
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
  mdbase-mirror init <directory> --server <origin> --collection <uuid> --replica <uuid> [--writable]
  mdbase-mirror sync <directory>
  mdbase-mirror watch <directory> [--interval <milliseconds>]
  mdbase-mirror resolve <directory> <record-id> --use <local|remote>

The init command prompts for the one-time replica token without echoing it.
For automation, pass the token through MDBASE_CONNECT_REPLICA_TOKEN.
`);
}
