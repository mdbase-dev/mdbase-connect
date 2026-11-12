import { verify, type Bundle } from "sigstore";
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import {
  channelForVersion,
  compareVersions,
  parseUpdateManifest,
  TAG_PATTERN,
  type UpdateChannel,
  type UpdateManifest
} from "./update-policy";

const GITHUB = "https://github.com";
const REPOSITORY = "mdbase-dev/mdbase-connect";
const WORKFLOW_IDENTITY_PREFIX =
  "https://github.com/mdbase-dev/mdbase-connect/.github/workflows/desktop-release.yml@refs/tags/";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
// This versioned channel document is the permanent updater bootstrap. Its
// schema stays intentionally small and frozen. Richer release metadata belongs
// in separately versioned assets.
const MANIFEST_NAME = "mdbase-connect-channel-v1.json";
const MANIFEST_BUNDLE_NAME = `${MANIFEST_NAME}.sigstore.json`;
// Release tags come from the repository's git refs, not GitHub's REST API: an
// unauthenticated client shares 60 REST requests an hour with everything else
// behind its public IP. One protocol-v2 `ls-refs` request lists every version
// tag, and release assets download from release URLs that the REST limit does
// not count.
const TAG_INDEX_URL = `${GITHUB}/${REPOSITORY}.git/git-upload-pack`;
const TAG_PREFIX = "refs/tags/";
const TAG_INDEX_REQUEST =
  `${pktLine("command=ls-refs\n")}${pktLine("object-format=sha1\n")}0001${pktLine(`ref-prefix ${TAG_PREFIX}v\n`)}0000`;
const MAX_TAG_INDEX_BYTES = 1024 * 1024;
// Most version tags have no desktop release (other trains tag them too), so
// manifests are probed a few at a time, newest first.
const MANIFEST_PROBE_BATCH = 8;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const responseTimeouts = new WeakMap<Response, ReturnType<typeof setTimeout>>();

export interface ReleaseCandidate {
  manifest: UpdateManifest;
  manifestBytes: Buffer;
  release: {
    tag: string;
    url: string;
  };
}

export interface ReleaseSourceOptions {
  channel: UpdateChannel;
  trustCacheDirectory: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  verifyBundle?: (
    bundle: unknown,
    payload: Buffer,
    identity: string,
    trustCacheDirectory: string
  ) => Promise<void>;
}

/**
 * The highest version on `channel` with valid signed update metadata. Tags are
 * tried newest first and the first one that verifies wins: the signed manifest's
 * version is its tag's, so no lower tag can beat it. A tag without a published
 * release is skipped; a release whose metadata fails is rejected without
 * preventing an older valid one from being found.
 */
export async function findLatestRelease(options: ReleaseSourceOptions): Promise<ReleaseCandidate | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const tags = (await fetchReleaseTags(fetchImpl, options.signal))
    .filter((tag) => channelForVersion(tag.slice(1)) === options.channel)
    .sort((left, right) => compareVersions(right.slice(1), left.slice(1)));
  const rejected: Error[] = [];
  const reject = (tag: string, error: unknown) => {
    options.signal?.throwIfAborted();
    rejected.push(
      new Error(
        `Rejected update metadata for ${tag}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    );
  };
  for (let start = 0; start < tags.length; start += MANIFEST_PROBE_BATCH) {
    const batch = tags.slice(start, start + MANIFEST_PROBE_BATCH);
    const manifests = await Promise.allSettled(batch.map(async (tag) => {
      const response = await request(fetchImpl, assetUrl(tag, MANIFEST_NAME), options.signal, { missing: "null" });
      return response && await readLimited(response, MAX_MANIFEST_BYTES);
    }));
    for (const [index, tag] of batch.entries()) {
      const manifest = manifests[index];
      if (manifest.status === "rejected") {
        reject(tag, manifest.reason);
        continue;
      }
      if (!manifest.value) continue;
      try {
        return await verifiedCandidate(tag, manifest.value, fetchImpl, options);
      } catch (error) {
        reject(tag, error);
      }
    }
  }
  if (rejected.length > 0) {
    throw new AggregateError(
      rejected,
      `No release had valid signed update metadata. ${rejected[0].message}`
    );
  }
  return null;
}

async function verifiedCandidate(
  tag: string,
  manifestBytes: Buffer,
  fetchImpl: typeof fetch,
  options: ReleaseSourceOptions
): Promise<ReleaseCandidate> {
  const bundleBytes = await readLimited(
    await request(fetchImpl, assetUrl(tag, MANIFEST_BUNDLE_NAME), options.signal),
    MAX_BUNDLE_BYTES
  );
  options.signal?.throwIfAborted();
  const identity = `${WORKFLOW_IDENTITY_PREFIX}${tag}`;
  const verifyBundle = options.verifyBundle ?? ((bundle, payload, signer, cache) =>
    verifyReleaseBundle(bundle, payload, signer, cache, options.signal));
  await verifyBundle(JSON.parse(bundleBytes.toString("utf8")), manifestBytes, identity, options.trustCacheDirectory);
  options.signal?.throwIfAborted();
  const manifest = parseUpdateManifest(JSON.parse(manifestBytes.toString("utf8")));
  const url = `${GITHUB}/${REPOSITORY}/releases/tag/${tag}`;
  if (manifest.tag !== tag) {
    throw new Error("Signed update manifest does not match its release tag.");
  }
  if (manifest.release_url !== url) {
    throw new Error("Signed update manifest does not match its release page.");
  }
  if (manifest.channel !== options.channel || channelForVersion(manifest.version) !== options.channel) {
    throw new Error("Signed update manifest is published on the wrong channel.");
  }
  return { manifest, manifestBytes, release: { tag, url } };
}

function assetUrl(tag: string, name: string): string {
  return `${GITHUB}/${REPOSITORY}/releases/download/${tag}/${name}`;
}

/** Every version tag in the repository, from one git protocol-v2 `ls-refs` request. */
async function fetchReleaseTags(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string[]> {
  const response = await request(fetchImpl, TAG_INDEX_URL, signal, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "git-protocol": "version=2"
    },
    body: TAG_INDEX_REQUEST
  });
  const tags: string[] = [];
  for (const line of parsePktLines(await readLimited(response, MAX_TAG_INDEX_BYTES))) {
    const match = /^[0-9a-f]{40} refs\/tags\/(\S+)$/.exec(line);
    if (!match) throw new Error("Update service returned an invalid tag index.");
    if (TAG_PATTERN.test(match[1])) tags.push(match[1]);
  }
  return tags;
}

function pktLine(payload: string): string {
  return (Buffer.byteLength(payload) + 4).toString(16).padStart(4, "0") + payload;
}

/** The data lines of one `ls-refs` response, which ends with a flush packet. */
export function parsePktLines(bytes: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString("latin1");
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      if (offset + 4 === bytes.length) return lines;
      break;
    }
    if (length < 5 || offset + length > bytes.length) break;
    const line = bytes.subarray(offset + 4, offset + length).toString("utf8").replace(/\n$/, "");
    if (line.startsWith("ERR ")) throw new Error(`Update service refused the tag index: ${line.slice(4)}`);
    lines.push(line);
    offset += length;
  }
  throw new Error("Update service returned an invalid tag index.");
}

export async function verifyArtifactBundle(input: {
  bundleBytes: Buffer;
  artifactBytes?: Buffer;
  artifactPath?: string;
  tag: string;
  trustCacheDirectory: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!TAG_PATTERN.test(input.tag)) {
    throw new Error("Cannot verify an artifact from an invalid release tag.");
  }
  let payload = input.artifactBytes;
  if (!payload && input.artifactPath) {
    const { readFile } = await import("node:fs/promises");
    payload = await readFile(input.artifactPath);
  }
  if (!payload) throw new Error("Artifact bytes are required for signature verification.");
  await verifyReleaseBundle(
    JSON.parse(input.bundleBytes.toString("utf8")),
    payload,
    `${WORKFLOW_IDENTITY_PREFIX}${input.tag}`,
    input.trustCacheDirectory,
    input.signal
  );
}

async function verifyReleaseBundle(
  bundle: unknown,
  payload: Buffer,
  identity: string,
  trustCacheDirectory: string,
  signal?: AbortSignal
): Promise<void> {
  const verifyAt = async (cachePath: string): Promise<void> => {
    signal?.throwIfAborted();
    await verify(bundle as Bundle, payload, {
      certificateIssuer: OIDC_ISSUER,
      certificateIdentityURI: identity,
      tlogThreshold: 1,
      ctLogThreshold: 1,
      tufCachePath: cachePath,
      timeout: 10_000,
      retry: { retries: 2 }
    });
    signal?.throwIfAborted();
  };
  try {
    await verifyAt(trustCacheDirectory);
  } catch (error) {
    signal?.throwIfAborted();
    if (!isRecoverableTrustCacheError(error)) throw error;
    await recoverTrustCache(trustCacheDirectory, verifyAt, error);
  }
}

export async function recoverTrustCache(
  trustCacheDirectory: string,
  verifyAt: (cachePath: string) => Promise<void>,
  originalError: unknown
): Promise<void> {
  const nonce = randomUUID();
  const recovery = `${trustCacheDirectory}.recovery-${nonce}`;
  const stale = `${trustCacheDirectory}.stale-${nonce}`;
  try {
    // A new Sigstore cache still bootstraps from the library's pinned TUF root
    // and performs the complete certificate, transparency-log and CT checks.
    // It is not a verification fallback or an alternate trust source.
    await verifyAt(recovery);
  } catch (recoveryError) {
    await rm(recovery, { recursive: true, force: true });
    throw new AggregateError(
      [originalError, recoveryError],
      "The cached and freshly bootstrapped Sigstore trust metadata both failed verification."
    );
  }

  let movedStale = false;
  try {
    await rename(trustCacheDirectory, stale);
    movedStale = true;
  } catch (error) {
    if (!isMissingPath(error)) {
      await rm(recovery, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    await rename(recovery, trustCacheDirectory);
  } catch (error) {
    if (movedStale) await rename(stale, trustCacheDirectory).catch(() => undefined);
    throw error;
  }
  if (movedStale) await rm(stale, { recursive: true, force: true }).catch(() => undefined);
}

export function isRecoverableTrustCacheError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (/root was signed by \d+\/\d+ keys|expired (?:root|TUF) metadata/i.test(current.message)) {
      return true;
    }
  }
  return false;
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

interface RequestInit {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Resolve a 404 to null: the release does not exist (or is not published). */
  missing?: "null";
}

function request(fetchImpl: typeof fetch, url: string, signal?: AbortSignal, init?: RequestInit & { missing?: undefined }): Promise<Response>;
function request(fetchImpl: typeof fetch, url: string, signal: AbortSignal | undefined, init: RequestInit): Promise<Response | null>;
async function request(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
  init: RequestInit = {}
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(url, {
    method: init.method ?? "GET",
    headers: { accept: "application/octet-stream", ...init.headers, "user-agent": "mdbase-connect-updater" },
    body: init.body,
    redirect: "follow",
    signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  }).catch((error) => {
    clearTimeout(timeout);
    throw error;
  });
  if (!response.ok) {
    clearTimeout(timeout);
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404 && init.missing === "null") return null;
    throw new Error(`Update service returned HTTP ${response.status}.`);
  }
  if (!response.url.startsWith("https://")) {
    clearTimeout(timeout);
    throw new Error("Update service redirected to an insecure URL.");
  }
  responseTimeouts.set(response, timeout);
  return response;
}

async function readLimited(response: Response, maximum: number): Promise<Buffer> {
  try {
    const lengthHeader = response.headers.get("content-length");
    const declared = lengthHeader === null ? null : Number(lengthHeader);
    if (declared !== null && Number.isFinite(declared) && declared > maximum) {
      throw new Error("Update response exceeds its size limit.");
    }
    if (!response.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > maximum) throw new Error("Update response exceeds its size limit.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
  } finally {
    const timeout = responseTimeouts.get(response);
    if (timeout) clearTimeout(timeout);
    responseTimeouts.delete(response);
  }
}
