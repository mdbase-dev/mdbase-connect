import { autoUpdater, shell } from "electron";
import { createReadStream } from "node:fs";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { findLatestRelease, verifyArtifactBundle } from "./release-source";
import type { UpdateBackend } from "./update-coordinator";
import {
  channelForVersion,
  type UpdateManifest,
  type UpdateTarget
} from "./update-policy";
import { artifactMatches, downloadArtifact, downloadBytes } from "./update-download";

const AUTO_UPDATER_TIMEOUT_MS = 180_000;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export interface ElectronUpdateBackendOptions {
  currentVersion: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  userDataDirectory: string;
}

/** The app's release channel; see update-coordinator.ts. */
export class ElectronUpdateBackend implements UpdateBackend {
  readonly currentVersion: string;
  readonly channel;
  readonly platformKey: string;
  readonly packaged: boolean;
  private readonly options: ElectronUpdateBackendOptions;

  constructor(options: ElectronUpdateBackendOptions) {
    this.options = options;
    this.currentVersion = options.currentVersion;
    this.channel = channelForVersion(options.currentVersion);
    this.platformKey = `${options.platform}-${options.arch}`;
    this.packaged = options.packaged;
  }

  async findLatest(): Promise<{ manifest: UpdateManifest } | null> {
    return findLatestRelease({
      channel: this.channel,
      trustCacheDirectory: join(this.options.userDataDirectory, "updates", "sigstore")
    });
  }

  async stageAutomatic(
    manifest: UpdateManifest,
    target: UpdateTarget,
    onProgress: (progress: number) => void
  ): Promise<void> {
    if (this.options.platform !== "darwin" || target.mode !== "automatic") {
      throw new Error("Automatic installation is only enabled for signed macOS releases.");
    }
    const artifact = target.artifacts.find((candidate) => candidate.kind === "zip");
    if (!artifact) throw new Error("The macOS update does not contain a ZIP artifact.");
    const directory = join(this.options.userDataDirectory, "updates", "downloads", manifest.version);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const archive = join(directory, artifact.name);
    const bundleBytes = await downloadBytes(artifact.sigstore_url, MAX_BUNDLE_BYTES);
    const cached = await artifactMatches(archive, artifact);
    if (!cached) {
      await rm(archive, { force: true });
      await downloadArtifact(artifact, archive, (progress) => onProgress(Math.min(90, progress * 0.9)));
    } else {
      onProgress(90);
    }
    await verifyArtifactBundle({
      bundleBytes,
      artifactPath: archive,
      tag: manifest.tag,
      trustCacheDirectory: join(this.options.userDataDirectory, "updates", "sigstore")
    }).catch(async (error) => {
      await rm(archive, { force: true });
      throw error;
    });
    onProgress(94);
    await stageMacUpdate(archive, manifest, onProgress);
  }

  installAutomatic(): void {
    autoUpdater.quitAndInstall();
  }

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }
}

async function stageMacUpdate(
  archive: string,
  manifest: UpdateManifest,
  onProgress: (progress: number) => void
): Promise<void> {
  const server = await localUpdateServer(archive, manifest);
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not create the local verified update feed.");
  }
  const feedUrl = `http://127.0.0.1:${address.port}/feed`;
  try {
    autoUpdater.setFeedURL({ url: feedUrl, serverType: "json" });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("The platform updater did not stage the release in time.")),
        AUTO_UPDATER_TIMEOUT_MS
      );
      const onDownloaded = () => finish();
      const onUnavailable = () => finish(new Error("The platform updater rejected the newer release."));
      const onError = (error: Error) => finish(error);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        autoUpdater.removeListener("update-downloaded", onDownloaded);
        autoUpdater.removeListener("update-not-available", onUnavailable);
        autoUpdater.removeListener("error", onError);
        error ? reject(error) : resolve();
      };
      autoUpdater.once("update-downloaded", onDownloaded);
      autoUpdater.once("update-not-available", onUnavailable);
      autoUpdater.once("error", onError);
      try {
        autoUpdater.checkForUpdates();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    onProgress(100);
  } finally {
    await closeServer(server);
  }
}

export async function localUpdateServer(archive: string, manifest: UpdateManifest): Promise<Server> {
  const details = await stat(archive);
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/feed") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { allow: "GET, HEAD" }).end();
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Local update feed is unavailable.");
        const payload = Buffer.from(
          JSON.stringify({
            url: `http://127.0.0.1:${address.port}/artifact`,
            name: manifest.version,
            notes: manifest.notes,
            pub_date: manifest.published_at
          })
        );
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": payload.length,
          "cache-control": "no-store"
        });
        response.end(request.method === "HEAD" ? undefined : payload);
        return;
      }
      if (request.url !== "/artifact") {
        response.writeHead(404).end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      let range;
      try {
        range = parseRange(request.headers.range, details.size);
      } catch {
        response.writeHead(416, { "content-range": `bytes */${details.size}` }).end();
        return;
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? details.size - 1;
      response.writeHead(range ? 206 : 200, {
        "content-type": "application/zip",
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
        ...(range ? { "content-range": `bytes ${start}-${end}/${details.size}` } : {})
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(archive, { start, end })
        .on("error", () => response.destroy())
        .pipe(response);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

export function parseRange(
  value: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) throw new Error("Invalid update range.");
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) {
    throw new Error("Invalid update range.");
  }
  return { start, end };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
