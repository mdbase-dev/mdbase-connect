import { createHash } from "node:crypto";

export const UPDATE_MANIFEST_SCHEMA_VERSION = 1;
export const UPDATE_CHANNELS = ["stable", "beta"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export type UpdateMode = "automatic" | "store" | "manual";

export interface UpdateArtifact {
  name: string;
  url: string;
  sigstore_url: string;
  sha256: string;
  size: number;
  kind: "zip" | "dmg" | "exe" | "deb" | "rpm";
}

export interface UpdateTarget {
  mode: UpdateMode;
  action_url: string;
  artifacts: UpdateArtifact[];
}

export interface UpdateManifest {
  schema_version: 1;
  version: string;
  tag: string;
  channel: UpdateChannel;
  published_at: string;
  release_url: string;
  notes: string;
  rollout: {
    percentage: number;
    seed: string;
  };
  blocked_versions: string[];
  targets: Record<string, UpdateTarget>;
}

/**
 * A release's current rollout stage (`docs/desktop-updates.md`, "Staged rollout").
 * The channel document's `rollout` is frozen when the release is published; this
 * separately signed document can be replaced later, so a release can widen in
 * stages without changing any published release asset.
 */
export interface RolloutDocument {
  schema: typeof ROLLOUT_SCHEMA;
  tag: string;
  version: string;
  issued_at: string;
  /** Installations that opted in to early access take the release. */
  early_access: boolean;
  /** Every other installation takes it when its cohort bucket is below this. */
  percentage: number;
}

export const ROLLOUT_SCHEMA = "mdbase-desktop-rollout/1";
/** Installations without early access take at most one optional update this often. */
export const UPDATE_SPACING_MS = 24 * 60 * 60 * 1000;

export type DeferredReason =
  /** Not this installation's cohort yet. */
  | "rollout"
  /** Only installations with early access take it so far. */
  | "early_access"
  /** Nobody takes it for now. */
  | "held"
  /** This installation updated less than a day ago. */
  | "spacing"
  /** The release's rollout document could not be verified, so it is not taken yet. */
  | "rollout_unavailable";

export type UpdateDecision =
  | { kind: "current" }
  | { kind: "blocked"; reason: string }
  | { kind: "deferred"; reason: DeferredReason; percentage: number; until?: string }
  /** `required`: this installation's version is blocked (below the minimum). */
  | { kind: "available"; target: UpdateTarget; required: boolean };

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** A release tag: `v` and a version without build metadata. */
export const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HTTPS_URL_PATTERN = /^https:\/\//;
const MAX_ARTIFACT_SIZE = 512 * 1024 * 1024;

interface ParsedVersion {
  main: [bigint, bigint, bigint];
  prerelease: Array<bigint | string>;
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.main.length; index += 1) {
    if (a.main[index] !== b.main[index]) return a.main[index] < b.main[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined || bPart === undefined) return aPart === undefined ? -1 : 1;
    if (aPart === bPart) continue;
    if (typeof aPart === "bigint" && typeof bPart === "bigint") return aPart < bPart ? -1 : 1;
    if (typeof aPart === "bigint") return -1;
    if (typeof bPart === "bigint") return 1;
    return aPart < bPart ? -1 : 1;
  }
  return 0;
}

export function channelForVersion(version: string): UpdateChannel {
  return parseVersion(version).prerelease.length === 0 ? "stable" : "beta";
}

/**
 * Whether an installation on `installed` takes releases published on `release`.
 * A beta installation also takes stable releases, so the newest of either wins
 * by semver order and `0.1.0` supersedes every `0.1.0-beta.N`: this is how beta
 * installations leave the beta line. A stable installation never takes a beta.
 */
export function acceptsReleaseChannel(installed: UpdateChannel, release: UpdateChannel): boolean {
  return release === installed || (installed === "beta" && release === "stable");
}

export function rolloutBucket(installationId: string, seed: string): number {
  if (!installationId || !seed) throw new Error("Rollout identity and seed are required.");
  const digest = createHash("sha256").update(`${seed}\0${installationId}`, "utf8").digest();
  return digest.readUInt32BE(0) % 10_000;
}

export function decideUpdate(input: {
  manifest: UpdateManifest;
  currentVersion: string;
  channel: UpdateChannel;
  platformKey: string;
  installationId: string;
  highestTrustedVersion?: string;
  manual?: boolean;
  /**
   * The verified rollout document for this release; null when none is published,
   * "unavailable" when one could not be read or verified.
   */
  rollout?: RolloutDocument | null | "unavailable";
  /** This installation opted in to early access. */
  earlyAccess?: boolean;
  /** When this installation started running `currentVersion`. */
  currentVersionSince?: string;
  /** Versions withdrawn by a newer release than `manifest`. */
  withdrawn?: readonly string[];
  now?: number;
}): UpdateDecision {
  const {
    manifest,
    currentVersion,
    channel,
    platformKey,
    installationId,
    highestTrustedVersion,
    manual = false,
    rollout = null,
    earlyAccess = false,
    currentVersionSince,
    withdrawn = [],
    now = Date.now()
  } = input;
  if (rollout && rollout !== "unavailable" && (rollout.tag !== manifest.tag || rollout.version !== manifest.version)) {
    throw new Error("The rollout document does not match its release.");
  }
  parseVersion(currentVersion);
  if (!acceptsReleaseChannel(channel, manifest.channel)) return { kind: "current" };
  if (highestTrustedVersion && compareVersions(manifest.version, highestTrustedVersion) < 0) {
    return { kind: "blocked", reason: "The release manifest is older than the last trusted release." };
  }
  if (manifest.blocked_versions.includes(manifest.version) || withdrawn.includes(manifest.version)) {
    return { kind: "blocked", reason: "The target release has been withdrawn." };
  }
  if (compareVersions(manifest.version, currentVersion) <= 0) return { kind: "current" };
  const target = manifest.targets[platformKey];
  if (!target) return { kind: "blocked", reason: `No update is published for ${platformKey}.` };
  const required = manifest.blocked_versions.includes(currentVersion) || withdrawn.includes(currentVersion);
  // Check now, and a version that must be replaced, bypass the rollout and spacing.
  if (manual || required) return { kind: "available", target, required };
  if (rollout === "unavailable") return { kind: "deferred", reason: "rollout_unavailable", percentage: 0 };
  // Without a rollout document the release's frozen percentage applies to everyone.
  const stage = rollout
    ? { percentage: rollout.percentage, earlyAccess: rollout.early_access }
    : { percentage: manifest.rollout.percentage, earlyAccess: manifest.rollout.percentage > 0 };
  const inCohort = rolloutBucket(installationId, manifest.rollout.seed) < Math.round(stage.percentage * 100);
  if (!inCohort && !(earlyAccess && stage.earlyAccess)) {
    const reason: DeferredReason = stage.percentage > 0 ? "rollout" : stage.earlyAccess ? "early_access" : "held";
    return { kind: "deferred", reason, percentage: stage.percentage };
  }
  if (!earlyAccess && currentVersionSince) {
    const next = Date.parse(currentVersionSince) + UPDATE_SPACING_MS;
    if (Number.isFinite(next) && now < next) {
      return { kind: "deferred", reason: "spacing", percentage: stage.percentage, until: new Date(next).toISOString() };
    }
  }
  return { kind: "available", target, required: false };
}

/** A rollout document, checked at the trust boundary like the channel document. */
export function parseRolloutDocument(value: unknown): RolloutDocument {
  const root = object(value, "Rollout document");
  exactKeys(root, ["schema", "tag", "version", "issued_at", "early_access", "percentage"], "Rollout document");
  if (root.schema !== ROLLOUT_SCHEMA) throw new Error(`Unsupported rollout document schema ${String(root.schema)}.`);
  const version = versionString(root.version, "version");
  const tag = string(root.tag, "tag");
  if (!TAG_PATTERN.test(tag) || tag !== `v${version}`) {
    throw new Error("Rollout document tag does not match its version.");
  }
  const issuedAt = string(root.issued_at, "issued_at");
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error("Rollout document issued_at is not an ISO timestamp.");
  if (typeof root.early_access !== "boolean") throw new Error("Rollout document early_access must be a boolean.");
  if (
    typeof root.percentage !== "number" ||
    !Number.isFinite(root.percentage) ||
    root.percentage < 0 ||
    root.percentage > 100
  ) {
    throw new Error("Rollout percentage must be between 0 and 100.");
  }
  return {
    schema: ROLLOUT_SCHEMA,
    tag,
    version,
    issued_at: new Date(issuedAt).toISOString(),
    early_access: root.early_access,
    percentage: root.percentage
  };
}

export function parseUpdateManifest(value: unknown): UpdateManifest {
  const root = object(value, "Update manifest");
  exactKeys(root, [
    "schema_version",
    "version",
    "tag",
    "channel",
    "published_at",
    "release_url",
    "notes",
    "rollout",
    "blocked_versions",
    "targets"
  ], "Update manifest");
  if (root.schema_version !== UPDATE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported update manifest schema ${String(root.schema_version)}.`);
  }
  const version = versionString(root.version, "version");
  const tag = string(root.tag, "tag");
  if (!TAG_PATTERN.test(tag) || tag !== `v${version}`) {
    throw new Error("Update manifest tag does not match its version.");
  }
  const channel = string(root.channel, "channel");
  if (!UPDATE_CHANNELS.includes(channel as UpdateChannel)) {
    throw new Error(`Unsupported update channel ${channel}.`);
  }
  if (channelForVersion(version) !== channel) {
    throw new Error("Update manifest channel does not match its version.");
  }
  const publishedAt = string(root.published_at, "published_at");
  if (!Number.isFinite(Date.parse(publishedAt))) {
    throw new Error("Update manifest published_at is not an ISO timestamp.");
  }
  const releaseUrl = httpsUrl(root.release_url, "release_url");
  const notes = string(root.notes, "notes", true);

  const rollout = object(root.rollout, "rollout");
  exactKeys(rollout, ["percentage", "seed"], "rollout");
  if (
    typeof rollout.percentage !== "number" ||
    !Number.isFinite(rollout.percentage) ||
    rollout.percentage < 0 ||
    rollout.percentage > 100
  ) {
    throw new Error("Update rollout percentage must be between 0 and 100.");
  }
  const seed = string(rollout.seed, "rollout.seed");

  if (!Array.isArray(root.blocked_versions)) {
    throw new Error("Update manifest blocked_versions must be an array.");
  }
  const blockedVersions = root.blocked_versions.map((entry, index) =>
    versionString(entry, `blocked_versions[${index}]`)
  );
  if (new Set(blockedVersions).size !== blockedVersions.length) {
    throw new Error("Update manifest blocked_versions contains duplicates.");
  }

  const rawTargets = object(root.targets, "targets");
  const targets: Record<string, UpdateTarget> = {};
  for (const [key, rawTarget] of Object.entries(rawTargets)) {
    if (!/^(darwin|win32|linux)-(arm64|x64)$/.test(key)) {
      throw new Error(`Unsupported update target ${key}.`);
    }
    targets[key] = parseTarget(rawTarget, key);
  }
  if (Object.keys(targets).length === 0) throw new Error("Update manifest has no targets.");

  return {
    schema_version: 1,
    version,
    tag,
    channel: channel as UpdateChannel,
    published_at: new Date(publishedAt).toISOString(),
    release_url: releaseUrl,
    notes,
    rollout: { percentage: rollout.percentage, seed },
    blocked_versions: blockedVersions,
    targets
  };
}

function parseTarget(value: unknown, key: string): UpdateTarget {
  const target = object(value, `target ${key}`);
  exactKeys(target, ["mode", "action_url", "artifacts"], `target ${key}`);
  const mode = string(target.mode, `${key}.mode`);
  if (!["automatic", "store", "manual"].includes(mode)) {
    throw new Error(`Unsupported update mode ${mode}.`);
  }
  const actionUrl = httpsUrl(target.action_url, `${key}.action_url`);
  if (!Array.isArray(target.artifacts)) throw new Error(`${key}.artifacts must be an array.`);
  const artifacts = target.artifacts.map((entry, index) => parseArtifact(entry, `${key}.artifacts[${index}]`));
  if (new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length) {
    throw new Error(`${key}.artifacts contains duplicate names.`);
  }
  if (mode === "automatic" && !artifacts.some((artifact) => artifact.kind === "zip")) {
    throw new Error(`${key} automatic updates require a ZIP artifact.`);
  }
  if (artifacts.length === 0 && mode !== "store") {
    throw new Error(`${key} must publish at least one artifact.`);
  }
  return { mode: mode as UpdateMode, action_url: actionUrl, artifacts };
}

function parseArtifact(value: unknown, label: string): UpdateArtifact {
  const artifact = object(value, label);
  exactKeys(artifact, ["name", "url", "sigstore_url", "sha256", "size", "kind"], label);
  const name = string(artifact.name, `${label}.name`);
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".." ||
    Buffer.byteLength(name, "utf8") > 240
  ) {
    throw new Error(`${label}.name is unsafe.`);
  }
  const sha256 = string(artifact.sha256, `${label}.sha256`);
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`${label}.sha256 is invalid.`);
  if (
    typeof artifact.size !== "number" ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    artifact.size > MAX_ARTIFACT_SIZE
  ) {
    throw new Error(`${label}.size is invalid.`);
  }
  const kind = string(artifact.kind, `${label}.kind`);
  if (!["zip", "dmg", "exe", "deb", "rpm"].includes(kind)) {
    throw new Error(`${label}.kind is invalid.`);
  }
  if (!name.toLowerCase().endsWith(`.${kind}`)) {
    throw new Error(`${label}.kind does not match its filename.`);
  }
  return {
    name,
    url: httpsUrl(artifact.url, `${label}.url`),
    sigstore_url: httpsUrl(artifact.sigstore_url, `${label}.sigstore_url`),
    sha256,
    size: artifact.size,
    kind: kind as UpdateArtifact["kind"]
  };
}

function parseVersion(value: string): ParsedVersion {
  const match = VERSION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid semantic version ${value}.`);
  const prerelease = match[4]
    ? match[4].split(".").map((part) => {
        if (/^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part)) {
          throw new Error(`Invalid semantic version ${value}.`);
        }
        return /^(0|[1-9]\d*)$/.test(part) ? BigInt(part) : part;
      })
    : [];
  return {
    main: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease
  };
}

function versionString(value: unknown, label: string): string {
  const result = string(value, label);
  parseVersion(result);
  return result;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function httpsUrl(value: unknown, label: string): string {
  const result = string(value, label);
  if (!HTTPS_URL_PATTERN.test(result)) throw new Error(`${label} must use HTTPS.`);
  const url = new URL(result);
  if (url.username || url.password || url.hash) throw new Error(`${label} is unsafe.`);
  return url.href;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} has unknown fields: ${extras.join(", ")}.`);
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(", ")}.`);
}
