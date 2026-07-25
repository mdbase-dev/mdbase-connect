import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mirrorDeviceDirectory } from "./node.js";
import { SyncError } from "./index.js";

export interface MirrorProfile {
  version: 1;
  provider_url: string;
  control_url?: string;
  collection_id: string;
  replica_id: string;
  mode: "read_only" | "read_write";
  name?: string;
  enrollment_id?: string;
  access_token_expires_at?: string;
}

export interface MirrorCredentials {
  access_token: string;
  refresh_token?: string;
}

export interface StoredMirrorProfile {
  profile: MirrorProfile;
  credentials: MirrorCredentials;
}

export async function loadMirrorProfile(
  root: string,
  stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
): Promise<StoredMirrorProfile> {
  const directory = await mirrorDeviceDirectory(root, stateRoot);
  const profile = await readJson<MirrorProfile>(join(directory, "profile.json"));
  const credentials = await readJson<MirrorCredentials>(join(directory, "credentials.json"));
  if (
    profile?.version !== 1
    || typeof profile.provider_url !== "string"
    || typeof profile.collection_id !== "string"
    || typeof profile.replica_id !== "string"
    || !["read_only", "read_write"].includes(profile.mode)
    || typeof credentials?.access_token !== "string"
  ) {
    throw new SyncError(
      "mirror_not_configured",
      `Mirror configuration is missing or invalid. Run mdbase-mirror connect ${root} first.`
    );
  }
  return { profile, credentials };
}

export async function saveMirrorProfile(
  root: string,
  profile: MirrorProfile,
  credentials: MirrorCredentials,
  stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
): Promise<void> {
  const directory = await mirrorDeviceDirectory(root, stateRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(join(directory, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`);
  await atomicWrite(join(directory, "credentials.json"), `${JSON.stringify(credentials, null, 2)}\n`);
}

export async function updateMirrorCredentials(
  root: string,
  credentials: MirrorCredentials,
  accessTokenExpiresAt?: string,
  stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
): Promise<StoredMirrorProfile> {
  const stored = await loadMirrorProfile(root, stateRoot);
  const profile = {
    ...stored.profile,
    ...(accessTokenExpiresAt ? { access_token_expires_at: accessTokenExpiresAt } : {})
  };
  await saveMirrorProfile(root, profile, credentials, stateRoot);
  return { profile, credentials };
}

export async function mirrorProfileDirectory(
  root: string,
  stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
): Promise<string> {
  return mirrorDeviceDirectory(root, stateRoot);
}

async function readJson<Value>(path: string): Promise<Value | null> {
  const value = await readOptional(path);
  if (value === null) return null;
  try {
    return JSON.parse(value) as Value;
  } catch {
    throw new SyncError("invalid_mirror_configuration", "Device-local mirror configuration is corrupt.");
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}
