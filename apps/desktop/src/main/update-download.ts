import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateArtifact } from "./update-policy";

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
const responseTimeouts = new WeakMap<Response, ReturnType<typeof setTimeout>>();

export async function downloadBytes(
  url: string,
  maximum: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS
): Promise<Buffer> {
  const response = await secureFetch(url, fetchImpl, timeoutMs);
  try {
    const declared = contentLength(response);
    if (declared !== null && declared > maximum) {
      throw new Error("Update signature is too large.");
    }
    if (!response.body) throw new Error("Update signature is empty.");
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > maximum) throw new Error("Update signature is too large.");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
  } finally {
    clearResponseTimeout(response);
  }
}

export async function downloadArtifact(
  artifact: UpdateArtifact,
  destination: string,
  onProgress: (progress: number) => void,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS
): Promise<void> {
  const response = await secureFetch(artifact.url, fetchImpl, timeoutMs);
  const temporary = `${destination}.part-${process.pid}`;
  try {
    const declared = contentLength(response);
    if (declared !== null && declared !== artifact.size) {
      throw new Error("Update artifact size does not match the signed manifest.");
    }
    if (!response.body) throw new Error("Update artifact is empty.");
    await rm(destination, { force: true });
    await rm(temporary, { force: true });
    const hash = createHash("sha256");
    let received = 0;
    const inspect = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > artifact.size) {
          callback(new Error("Update artifact exceeds its signed size."));
          return;
        }
        hash.update(chunk);
        onProgress((received / artifact.size) * 100);
        callback(null, chunk);
      }
    });
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      inspect,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 })
    );
    if (received !== artifact.size || hash.digest("hex") !== artifact.sha256) {
      throw new Error("Update artifact does not match its signed digest.");
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    clearResponseTimeout(response);
  }
}

export async function artifactMatches(path: string, artifact: UpdateArtifact): Promise<boolean> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size !== artifact.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex") === artifact.sha256;
  } catch {
    return false;
  }
}

async function secureFetch(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<Response> {
  if (!url.startsWith("https://")) throw new Error("Update downloads must use HTTPS.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetchImpl(url, {
    headers: { "user-agent": "mdbase-connect-updater" },
    redirect: "follow",
    signal: controller.signal
  }).catch((error) => {
    clearTimeout(timeout);
    throw error;
  });
  if (!response.ok) {
    clearTimeout(timeout);
    throw new Error(`Update download returned HTTP ${response.status}.`);
  }
  if (!response.url.startsWith("https://")) {
    clearTimeout(timeout);
    throw new Error("Update download redirected to an insecure URL.");
  }
  responseTimeouts.set(response, timeout);
  return response;
}

function clearResponseTimeout(response: Response): void {
  const timeout = responseTimeouts.get(response);
  if (timeout) clearTimeout(timeout);
  responseTimeouts.delete(response);
}

function contentLength(response: Response): number | null {
  const value = response.headers.get("content-length");
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
