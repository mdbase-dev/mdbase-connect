/**
 * Finding the desktop daemon from Obsidian (`replica-client-api.md` §12.4).
 *
 * The daemon writes into its owner-only state directory:
 * - `local-link.json` = `{"port": n, "token": "<64 hex>"}`, with a fresh token at each
 *   daemon start;
 * - `daemon.json` = `{"schema_version": 1, "device", "noise_pk", "sign_pk", "kem_pk"}`.
 *
 * The plugin reads both with the desktop file API (Node `fs` in Obsidian desktop).
 * Before it trusts them, it applies strict `daemon.json` checks:
 * - neither the directory nor the files may be symlinks;
 * - they must be owned by this user;
 * - they must not be writable by group or others.
 *
 * Neither file is ever placed in, or copied into, the vault. On mobile there is no
 * daemon, and {@link findDaemon} returns `null`.
 */

/** The `fs` calls used (Node's `fs/promises` on desktop; injected for tests). */
export interface LinkFs {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; uid: number; mode: number }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

/** What the plugin needs to open the link. */
export interface DaemonLink {
  readonly url: string;
  /** 32 bytes; sent only inside the first Noise message (§12.4). */
  readonly token: Uint8Array;
  readonly device: string;
  /** The daemon's replica Noise key: the responder static key to pin. */
  readonly noisePk: Uint8Array;
}

/** Why the daemon can't be used. Any of these means "keep or resume hosting" (§13 rule 4). */
export type LinkProblem = "absent" | "insecure" | "malformed";

/** The daemon's state directory (as `crates/daemon/src/paths.rs`). */
export function daemonStateDir(platform: string, env: { HOME?: string; LOCALAPPDATA?: string }): string | null {
  switch (platform) {
    case "win32":
      return env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\mdbase\\state` : null;
    case "darwin":
      return env.HOME ? `${env.HOME}/Library/Application Support/mdbase` : null;
    case "linux":
      return env.HOME ? `${env.HOME}/.local/state/mdbase` : null;
    default:
      return null;
  }
}

function hexBytes(s: unknown, len: number): Uint8Array | null {
  if (typeof s !== "string" || !new RegExp(`^[0-9a-f]{${len * 2}}$`).test(s)) return null;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * Owner-only check. On Windows the directory ACL is the protection, and
 * `fs.lstat` can't show it, so only the symlink check applies there. The daemon
 * creates the directory with a user-only ACL.
 */
async function ownerOnly(fs: LinkFs, path: string, uid: number | null, kind: "dir" | "file"): Promise<boolean> {
  const st = await fs.lstat(path);
  if (st.isSymbolicLink()) return false;
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return false;
  if (uid === null) return true;
  return st.uid === uid && (st.mode & 0o022) === 0;
}

/**
 * Locate and verify the daemon link. `uid` is `process.getuid()`, or `null` on
 * Windows.
 */
export async function findDaemon(fs: LinkFs, stateDir: string | null, uid: number | null, sep = "/"): Promise<{ link: DaemonLink } | { problem: LinkProblem }> {
  if (!stateDir) return { problem: "absent" };
  const linkFile = `${stateDir}${sep}local-link.json`;
  const idFile = `${stateDir}${sep}daemon.json`;
  try {
    if (!(await ownerOnly(fs, stateDir, uid, "dir")) || !(await ownerOnly(fs, linkFile, uid, "file")) || !(await ownerOnly(fs, idFile, uid, "file"))) {
      return { problem: "insecure" };
    }
  } catch (e) {
    return { problem: (e as { code?: string }).code === "ENOENT" ? "absent" : "insecure" };
  }
  let link: { port?: unknown; token?: unknown };
  let id: { schema_version?: unknown; device?: unknown; noise_pk?: unknown };
  try {
    link = JSON.parse(await fs.readFile(linkFile, "utf8"));
    id = JSON.parse(await fs.readFile(idFile, "utf8"));
  } catch (e) {
    return { problem: (e as { code?: string }).code === "ENOENT" ? "absent" : "malformed" };
  }
  const token = hexBytes(link.token, 32);
  const noisePk = hexBytes(id.noise_pk, 32);
  const port = link.port;
  const deviceOk = typeof id.device === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id.device);
  if (id.schema_version !== 1 || !token || !noisePk || !deviceOk || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { problem: "malformed" };
  }
  // Loopback only, never a hostname a resolver could redirect.
  return { link: { url: `ws://127.0.0.1:${port}/v1/plugin`, token, device: id.device as string, noisePk } };
}

/**
 * The first Noise payload of §12.4: `{0: token, 1: hello-params}`. `helloParams` is
 * an already encoded `mdb-cbor/1` item, embedded as it is. The map is written by
 * hand so this module needs no codec. It is canonical: keys in order, definite
 * lengths.
 */
export function firstPayload(token: Uint8Array, helloParams: Uint8Array): Uint8Array {
  if (token.length !== 32) throw new Error("token is 32 bytes");
  const out = new Uint8Array(1 + 1 + 2 + 32 + 1 + helloParams.length);
  let o = 0;
  out[o++] = 0xa2; // map(2)
  out[o++] = 0x00; // key 0
  out[o++] = 0x58; // bstr, 1-byte length
  out[o++] = 32;
  out.set(token, o);
  o += 32;
  out[o++] = 0x01; // key 1
  out.set(helloParams, o);
  return out;
}
