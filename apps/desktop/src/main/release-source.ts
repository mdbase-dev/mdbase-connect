import { verify, type Bundle } from "sigstore";
import {
  channelForVersion,
  compareVersions,
  parseUpdateManifest,
  type UpdateChannel,
  type UpdateManifest
} from "./update-policy";

const GITHUB_API = "https://api.github.com";
const REPOSITORY = "mdbase-dev/mdbase-connect";
const WORKFLOW_IDENTITY_PREFIX =
  "https://github.com/mdbase-dev/mdbase-connect/.github/workflows/desktop-release.yml@refs/tags/";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
// This versioned channel document is the permanent updater bootstrap. Its
// schema stays intentionally small and frozen. Richer release metadata belongs
// in separately versioned assets.
const MANIFEST_NAME = "mdbase-connect-channel-v1.json";
const MANIFEST_BUNDLE_NAME = `${MANIFEST_NAME}.sigstore.json`;
const MAX_RELEASE_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const responseTimeouts = new WeakMap<Response, ReturnType<typeof setTimeout>>();

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  html_url: string;
  assets: GitHubAsset[];
}

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
  verifyBundle?: (
    bundle: unknown,
    payload: Buffer,
    identity: string,
    trustCacheDirectory: string
  ) => Promise<void>;
}

export async function findLatestRelease(options: ReleaseSourceOptions): Promise<ReleaseCandidate | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const indexUrl = `${GITHUB_API}/repos/${REPOSITORY}/releases?per_page=100`;
  const response = await request(fetchImpl, indexUrl);
  const releases = parseReleaseIndex(
    JSON.parse((await readLimited(response, MAX_RELEASE_INDEX_BYTES)).toString("utf8"))
  );
  const matching = releases.filter(
    (release) =>
      !release.draft &&
      (options.channel === "beta" ? release.prerelease : !release.prerelease) &&
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name)
  );
  let best: ReleaseCandidate | null = null;
  const rejected: Error[] = [];
  for (const release of matching) {
    const manifestAsset = release.assets.find((asset) => asset.name === MANIFEST_NAME);
    const bundleAsset = release.assets.find((asset) => asset.name === MANIFEST_BUNDLE_NAME);
    if (!manifestAsset || !bundleAsset) continue;
    try {
      const [manifestResponse, bundleResponse] = await Promise.all([
        request(fetchImpl, manifestAsset.browser_download_url),
        request(fetchImpl, bundleAsset.browser_download_url)
      ]);
      const [manifestBytes, bundleBytes] = await Promise.all([
        readLimited(manifestResponse, MAX_MANIFEST_BYTES),
        readLimited(bundleResponse, MAX_BUNDLE_BYTES)
      ]);
      const identity = `${WORKFLOW_IDENTITY_PREFIX}${release.tag_name}`;
      const verifyBundle = options.verifyBundle ?? verifyReleaseBundle;
      await verifyBundle(
        JSON.parse(bundleBytes.toString("utf8")),
        manifestBytes,
        identity,
        options.trustCacheDirectory
      );
      const manifest = parseUpdateManifest(JSON.parse(manifestBytes.toString("utf8")));
      if (manifest.tag !== release.tag_name) {
        throw new Error("Signed update manifest does not match its release tag.");
      }
      if (manifest.release_url !== new URL(release.html_url).href) {
        throw new Error("Signed update manifest does not match its release page.");
      }
      if (manifest.channel !== options.channel || channelForVersion(manifest.version) !== options.channel) {
        throw new Error("Signed update manifest is published on the wrong channel.");
      }
      if (!best || compareVersions(manifest.version, best.manifest.version) > 0) {
        best = { manifest, manifestBytes, release: { tag: release.tag_name, url: release.html_url } };
      }
    } catch (error) {
      rejected.push(
        new Error(
          `Rejected update metadata for ${release.tag_name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error }
        )
      );
    }
  }
  if (!best && rejected.length > 0) {
    throw new AggregateError(
      rejected,
      `No release had valid signed update metadata. ${rejected[0].message}`
    );
  }
  return best;
}

export async function verifyArtifactBundle(input: {
  bundleBytes: Buffer;
  artifactBytes?: Buffer;
  artifactPath?: string;
  tag: string;
  trustCacheDirectory: string;
}): Promise<void> {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.tag)) {
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
    input.trustCacheDirectory
  );
}

async function verifyReleaseBundle(
  bundle: unknown,
  payload: Buffer,
  identity: string,
  trustCacheDirectory: string
): Promise<void> {
  await verify(bundle as Bundle, payload, {
    certificateIssuer: OIDC_ISSUER,
    certificateIdentityURI: identity,
    tlogThreshold: 1,
    ctLogThreshold: 1,
    tufCachePath: trustCacheDirectory,
    timeout: 10_000,
    retry: { retries: 2 }
  });
}

async function request(fetchImpl: typeof fetch, url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json, application/octet-stream",
      "user-agent": "mdbase-connect-updater"
    },
    redirect: "follow",
    signal: controller.signal
  }).catch((error) => {
    clearTimeout(timeout);
    throw error;
  });
  if (!response.ok) {
    clearTimeout(timeout);
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

function parseReleaseIndex(value: unknown): GitHubRelease[] {
  if (!Array.isArray(value)) throw new Error("Update service returned an invalid release index.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Update service returned an invalid release.");
    }
    const release = entry as Record<string, unknown>;
    if (
      typeof release.draft !== "boolean" ||
      typeof release.prerelease !== "boolean" ||
      typeof release.tag_name !== "string" ||
      typeof release.html_url !== "string" ||
      !release.html_url.startsWith("https://") ||
      !Array.isArray(release.assets)
    ) {
      throw new Error("Update service returned an invalid release.");
    }
    const assets = release.assets.map((asset) => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
        throw new Error("Update service returned an invalid release asset.");
      }
      const value = asset as Record<string, unknown>;
      if (
        typeof value.name !== "string" ||
        typeof value.browser_download_url !== "string" ||
        !value.browser_download_url.startsWith("https://") ||
        typeof value.size !== "number" ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0
      ) {
        throw new Error("Update service returned an invalid release asset.");
      }
      return {
        name: value.name,
        browser_download_url: value.browser_download_url,
        size: value.size
      };
    });
    return {
      draft: release.draft,
      prerelease: release.prerelease,
      tag_name: release.tag_name,
      html_url: new URL(release.html_url).href,
      assets
    };
  });
}
