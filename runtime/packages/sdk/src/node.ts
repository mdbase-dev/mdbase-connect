/**
 * `@mdbase-dev/sdk/node`: local IPC to the desktop daemon (`replica-client-api.md`
 * §12.2). Node only (Electron main, CLIs, MCP servers, tests).
 *
 * - Linux: `$XDG_RUNTIME_DIR/mdbase/replica.sock`
 * - macOS: `~/Library/Application Support/mdbase/replica.sock`
 * - Windows: `\\.\pipe\mdbase-replica-<user SID>`
 *
 * Authentication is the same Noise IK handshake as remote clients, with the daemon's
 * replica Noise key. Noise messages travel as `u16be(length) ‖ message`. The key comes
 * from `daemon.json` in the daemon's owner-checked state directory, never from beside
 * the socket or pipe, so whoever holds the endpoint name can't impersonate
 * the daemon.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { connect as netConnect, Socket } from "node:net";
import { homedir, platform } from "node:os";
import { join, win32 } from "node:path";
import { fromHex } from "./cbor.js";
import { uuidToBytes } from "./codec.js";
import { mdbaseError } from "./errors.js";
import type { Uuid } from "./wire.js";
import { clientPrologue, KeyPair, StaticKey } from "./transport/noise.js";
import { ByteStream, MessageCarrier, noiseConnector, streamCarrier, WebSocketFactory } from "./transport/noise-session.js";
import { LocalLink, localLinkConnector } from "./transport/local-link.js";
import type { Connector } from "./transport/port.js";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length ? v : undefined;
}

/**
 * The daemon's per-user state directory, as `crates/daemon` (`paths.rs`) defines it:
 * - Linux: `~/.local/state/mdbase` (fixed: `XDG_STATE_HOME` is **not** honoured, so
 *   apps and a daemon started from different environments always agree)
 * - macOS: `~/Library/Application Support/mdbase`
 * - Windows: `%LOCALAPPDATA%\mdbase\state`
 */
export function defaultDaemonStateDir(os: NodeJS.Platform = platform()): string {
  switch (os) {
    case "win32": {
      const base = env("LOCALAPPDATA");
      if (!base) throw mdbaseError("unavailable", "LOCALAPPDATA is not set");
      return win32.join(base, "mdbase", "state");
    }
    case "darwin":
      return join(homedir(), "Library", "Application Support", "mdbase");
    default:
      return join(homedir(), ".local", "state", "mdbase");
  }
}

/** The daemon's replica endpoint for the current user (§12.2). */
export function defaultIpcPath(sid?: string, os: NodeJS.Platform = platform()): string {
  switch (os) {
    case "win32":
      if (!sid) throw mdbaseError("invalid_request", "pass the user SID for the named pipe path");
      return `\\\\.\\pipe\\mdbase-replica-${sid}`;
    case "darwin":
      return join(defaultDaemonStateDir(os), "replica.sock");
    default: {
      const run = env("XDG_RUNTIME_DIR");
      return run ? join(run, "mdbase", "replica.sock") : join(defaultDaemonStateDir(os), "run", "replica.sock");
    }
  }
}

export interface DaemonIdentity {
  /** The daemon's device ID (the Noise target). */
  device: Uuid;
  /** Its replica Noise public key. */
  noisePublicKey: Uint8Array;
}

/**
 * Where `daemon.json` lives: the daemon's state directory, **never** beside the socket.
 * A named pipe's "directory" is `\\.\pipe\`, a namespace any local user can create
 * names in, so deriving the file from the pipe path would let them supply their own
 * Noise key. Throws for a location that isn't an ordinary per-user path.
 */
export function daemonIdentityFile(stateDir: string, os: NodeJS.Platform = platform()): string {
  if (os === "win32") {
    const norm = stateDir.replace(/\//g, "\\");
    if (norm.startsWith("\\\\")) {
      throw mdbaseError("invalid_request", `daemon state directory must be a local path, not ${stateDir}`, "untrusted_identity");
    }
    if (!win32.isAbsolute(norm)) throw mdbaseError("invalid_request", "daemon state directory must be absolute");
    return win32.join(norm, "daemon.json");
  }
  if (!stateDir.startsWith("/")) throw mdbaseError("invalid_request", "daemon state directory must be absolute");
  return join(stateDir, "daemon.json");
}

function untrusted(p: string, st: { isSymbolicLink(): boolean; uid: number; mode: number }): string | null {
  const uid = process.getuid?.();
  if (st.isSymbolicLink()) return `${p} is a symlink`;
  if (uid !== undefined && st.uid !== uid) return `${p} is owned by another user`;
  if ((st.mode & 0o022) !== 0) return `${p} is writable by group or others`;
  return null;
}

function refuse(why: string): never {
  throw mdbaseError("unauthenticated", `refusing the daemon identity: ${why}`, "untrusted_identity");
}

function notRunning(p: string): never {
  throw mdbaseError("unavailable", `the mdbase daemon is not running (no ${p})`, "daemon_not_running");
}

/**
 * Read the daemon's identity, `{"device": "<uuid>", "noise_pk": "<64 hex>"}`, from
 * `daemon.json` in its state directory, after checking who owns it.
 */
/**
 * Read an owner-only JSON file from the daemon's state directory: the directory is
 * `lstat`-checked, the file is opened (`O_NOFOLLOW`) and then the **opened handle** is
 * checked (regular file, owned by this uid, no group/other write), so there is no
 * check-then-read race.
 */
async function readOwnerOnlyJson<T>(stateDir: string, name: string): Promise<{ file: string; json: T }> {
  const file = daemonIdentityFile(stateDir).replace(/daemon\.json$/, name);
  const posix = platform() !== "win32";
  if (posix) {
    let st;
    try {
      st = await lstat(stateDir);
    } catch {
      notRunning(stateDir);
    }
    const why = untrusted(stateDir, st);
    if (why) refuse(why);
  }
  let fh;
  try {
    fh = await open(file, posix ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW : "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") refuse(`${file} is a symlink`);
    notRunning(file);
  }
  let raw: string;
  try {
    const st = await fh.stat();
    if (!st.isFile()) refuse(`${file} is not a regular file`);
    if (posix) {
      const why = untrusted(file, { isSymbolicLink: () => false, uid: st.uid, mode: st.mode });
      if (why) refuse(why);
    }
    raw = await fh.readFile("utf8");
  } finally {
    await fh.close();
  }
  try {
    return { file, json: JSON.parse(raw) as T };
  } catch {
    throw mdbaseError("internal", `${file} is not valid JSON`);
  }
}

/**
 * Read the daemon's identity, `{"device": "<uuid>", "noise_pk": "<64 hex>"}`, from
 * `daemon.json` in its state directory, after checking who owns it.
 */
export async function readDaemonIdentity(stateDir: string = defaultDaemonStateDir()): Promise<DaemonIdentity> {
  const { file, json: j } = await readOwnerOnlyJson<{ schema_version?: number; device?: string; noise_pk?: string }>(
    stateDir,
    "daemon.json",
  );
  if (j.schema_version !== undefined && j.schema_version !== 1) {
    throw mdbaseError("upgrade_required", `${file} has schema_version ${j.schema_version}`);
  }
  if (!j.device || !j.noise_pk || !/^[0-9a-f]{64}$/.test(j.noise_pk)) {
    throw mdbaseError("internal", `${file} is incomplete`);
  }
  return { device: j.device, noisePublicKey: fromHex(j.noise_pk) };
}

/**
 * The localhost link (§12.4): `local-link.json` (`{port, token}`) plus the pinned
 * identity from `daemon.json`, both owner-checked.
 */
export async function readLocalLink(stateDir: string = defaultDaemonStateDir()): Promise<LocalLink> {
  const id = await readDaemonIdentity(stateDir);
  const { file, json: j } = await readOwnerOnlyJson<{ port?: number; token?: string }>(stateDir, "local-link.json");
  if (!Number.isInteger(j.port) || !j.token || !/^[0-9a-f]{64}$/.test(j.token)) {
    throw mdbaseError("internal", `${file} is incomplete`);
  }
  return { port: j.port!, token: fromHex(j.token), device: id.device, noisePublicKey: id.noisePublicKey };
}

/**
 * Connect to the desktop daemon over the localhost link as the hosting session of
 * `collection` (§12.4). Re-reads the link files on every reconnect (new port and token
 * at each daemon start). For Obsidian, pass `webSocket` if the global one isn't used.
 */
export function connectDaemonLocalhost(o: {
  collection: Uuid;
  localOnly?: boolean;
  stateDir?: string;
  webSocket?: WebSocketFactory;
}): Connector {
  return localLinkConnector({
    collection: o.collection,
    ...(o.localOnly ? { localOnly: true } : {}),
    ...(o.webSocket ? { webSocket: o.webSocket } : {}),
    link: () => readLocalLink(o.stateDir),
  });
}

function socketStream(sock: Socket): ByteStream {
  const s: ByteStream = {
    ondata: null,
    onclose: null,
    write: (b) => void sock.write(b),
    close: () => sock.destroy(),
  };
  sock.on("data", (d: Buffer) => s.ondata?.(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
  sock.on("close", () => s.onclose?.());
  sock.on("error", (e) => s.onclose?.(e));
  return s;
}

function openSocket(path: string, signal?: AbortSignal): Promise<MessageCarrier> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(path);
    const onAbort = () => {
      sock.destroy();
      reject(mdbaseError("cancelled", "connect aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    sock.once("connect", () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(streamCarrier(socketStream(sock)));
    });
    sock.once("error", (e: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", onAbort);
      const notRunning = e.code === "ENOENT" || e.code === "ECONNREFUSED";
      reject(
        mdbaseError("unavailable", notRunning ? "the mdbase daemon is not running" : e.message, {
          ...(notRunning ? { reason: "daemon_not_running" } : {}),
          retryAfterMs: 1000,
        }),
      );
    });
  });
}

export interface IpcConnectorOptions {
  collection: Uuid;
  /** The app's grant, or null for the hosting app itself. */
  grant: Uuid | null;
  staticKey: KeyPair | StaticKey;
  /** Socket or pipe path; default {@link defaultIpcPath}. */
  path?: string;
  /** The daemon's identity; default read from `daemon.json` in its state directory. */
  daemon?: DaemonIdentity;
  /** The daemon's state directory (isolated daemons); default {@link defaultDaemonStateDir}. */
  stateDir?: string;
}

/** A connector to the desktop daemon over local IPC. */
export function ipcConnector(o: IpcConnectorOptions): Connector {
  const collection = uuidToBytes(o.collection);
  const grant = o.grant ? uuidToBytes(o.grant) : null;
  return noiseConnector({
    description: `ipc:${o.path ?? "default"}`,
    staticKey: o.staticKey,
    target: async () => {
      const path = o.path ?? defaultIpcPath();
      const daemon = o.daemon ?? (await readDaemonIdentity(o.stateDir));
      const prologue = clientPrologue(collection, grant, uuidToBytes(daemon.device));
      return {
        prologue,
        remoteStatic: daemon.noisePublicKey,
        // One daemon serves many collections on one socket: the prologue goes first,
        // in clear, as one `u16be(64) ‖ prologue` record so the daemon can pick the
        // collection and grant (daemon interface note §3). Tampering fails the handshake.
        preamble: prologue,
        device: daemon.device,
        openCarrier: (signal) => openSocket(path, signal),
      };
    },
  });
}
