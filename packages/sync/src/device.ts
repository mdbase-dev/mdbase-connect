import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
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

export interface AuthorityPromotionReceipt {
  version: 1;
  collection_id: string;
  authority_epoch: number;
  promoted_at: string;
}

export interface AuthorityPromotionCheckpoint {
  version: 1;
  transfer_id: string;
  collection_id: string;
  manifest_digest: string;
  authority_epoch: number;
  expires_at: string;
  original_configuration: string;
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

export async function setHostedCollectionIdentity(
  root: string,
  collectionId: string
): Promise<string> {
  const configurationPath = join(await realpath(root), "mdbase.yaml");
  const metadata = await lstat(configurationPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new SyncError(
      "unsafe_collection_configuration",
      "mdbase.yaml must be an ordinary file inside the promoted collection."
    );
  }
  const source = await readFile(configurationPath, "utf8");
  const document = parseDocument(source);
  if (document.errors.length || !isMap(document.contents)) {
    throw new SyncError(
      "invalid_collection_configuration",
      "mdbase.yaml must contain a valid YAML mapping."
    );
  }
  const extension = document.get("x-mdbase-connect", true);
  if (extension !== undefined && !isMap(extension)) {
    throw new SyncError(
      "invalid_collection_configuration",
      "x-mdbase-connect must be a YAML mapping."
    );
  }
  if (extension === undefined) {
    document.set("x-mdbase-connect", document.createNode({}));
  }
  const connect = document.get("x-mdbase-connect", true);
  if (!isMap(connect)) {
    throw new SyncError(
      "invalid_collection_configuration",
      "x-mdbase-connect must be a YAML mapping."
    );
  }
  const existing = connect.get("collection_id");
  if (existing !== undefined && existing !== collectionId) {
    throw new SyncError(
      "collection_identity_conflict",
      "This folder already has a different mdbase connect collection identity."
    );
  }
  connect.set("collection_id", collectionId);
  await atomicWrite(configurationPath, document.toString(), metadata.mode & 0o777);
  return source;
}

export async function readCollectionConfiguration(root: string): Promise<string> {
  const configurationPath = join(await realpath(root), "mdbase.yaml");
  const metadata = await lstat(configurationPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new SyncError(
      "unsafe_collection_configuration",
      "mdbase.yaml must be an ordinary file inside the promoted collection."
    );
  }
  return readFile(configurationPath, "utf8");
}

export async function restoreCollectionConfiguration(
  root: string,
  source: string
): Promise<void> {
  const configurationPath = join(await realpath(root), "mdbase.yaml");
  const metadata = await stat(configurationPath);
  await atomicWrite(configurationPath, source, metadata.mode & 0o777);
}

export async function retireMirrorAfterPromotion(
  root: string,
  receipt: Omit<AuthorityPromotionReceipt, "version" | "promoted_at">,
  stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
): Promise<void> {
  const directory = await mirrorDeviceDirectory(root, stateRoot);
  await atomicWrite(
    join(directory, "authority.json"),
    `${JSON.stringify({
      version: 1,
      ...receipt,
      promoted_at: new Date().toISOString()
    } satisfies AuthorityPromotionReceipt, null, 2)}\n`
  );
  for (const name of [
    "credentials.json",
    "profile.json",
    "mirror-state.json",
    "authority-promotion.json"
  ]) {
    await unlinkOptional(join(directory, name));
  }
}

export async function loadAuthorityPromotionCheckpoint(
  root: string,
  stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
): Promise<AuthorityPromotionCheckpoint | null> {
  const directory = await mirrorDeviceDirectory(root, stateRoot);
  const checkpoint = await readJson<AuthorityPromotionCheckpoint>(
    join(directory, "authority-promotion.json")
  );
  if (checkpoint === null) return null;
  if (
    checkpoint.version !== 1
    || typeof checkpoint.transfer_id !== "string"
    || typeof checkpoint.collection_id !== "string"
    || typeof checkpoint.manifest_digest !== "string"
    || !/^[a-f0-9]{64}$/.test(checkpoint.manifest_digest)
    || !Number.isSafeInteger(checkpoint.authority_epoch)
    || checkpoint.authority_epoch < 2
    || typeof checkpoint.expires_at !== "string"
    || !Number.isFinite(new Date(checkpoint.expires_at).getTime())
    || typeof checkpoint.original_configuration !== "string"
  ) {
    throw new SyncError(
      "invalid_authority_promotion_checkpoint",
      "The saved authority promotion is invalid."
    );
  }
  return checkpoint;
}

export async function saveAuthorityPromotionCheckpoint(
  root: string,
  checkpoint: Omit<AuthorityPromotionCheckpoint, "version">,
  stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
): Promise<void> {
  const directory = await mirrorDeviceDirectory(root, stateRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(
    join(directory, "authority-promotion.json"),
    `${JSON.stringify({ version: 1, ...checkpoint } satisfies AuthorityPromotionCheckpoint, null, 2)}\n`
  );
}

export async function clearAuthorityPromotionCheckpoint(
  root: string,
  stateRoot = process.env.MDBASE_CONNECT_MIRROR_STATE_DIR
): Promise<void> {
  const directory = await mirrorDeviceDirectory(root, stateRoot);
  await unlinkOptional(join(directory, "authority-promotion.json"));
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

async function unlinkOptional(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWrite(path: string, value: string, mode = 0o600): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode });
  await rename(temporary, path);
}
