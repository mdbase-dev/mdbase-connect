import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  artifactMatches,
  downloadArtifact,
  downloadBytes
} = require("../dist/main/update-download.js");

function response(body, url = "https://downloads.example/artifact", headers = {}) {
  const value = new Response(body, { status: 200, headers });
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function artifact(bytes, overrides = {}) {
  return {
    name: "update.zip",
    url: "https://downloads.example/update.zip",
    sigstore_url: "https://downloads.example/update.zip.sigstore.json",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    kind: "zip",
    ...overrides
  };
}

test("artifact download streams, reports progress, and atomically verifies digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-download-"));
  const destination = join(directory, "update.zip");
  const bytes = Buffer.alloc(128 * 1024, 17);
  const progress = [];
  await writeFile(destination, "corrupt cache entry");
  await downloadArtifact(
    artifact(bytes),
    destination,
    (value) => progress.push(value),
    async () =>
      response(bytes, "https://cdn.example/update.zip", {
        "content-length": String(bytes.length)
      })
  );
  assert.deepEqual(await readFile(destination), bytes);
  assert.equal(progress.at(-1), 100);
  assert.equal(await artifactMatches(destination, artifact(bytes)), true);
});

test("digest mismatch removes partial output and cannot become a staged artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-download-"));
  const destination = join(directory, "update.zip");
  const bytes = Buffer.from("tampered update");
  await assert.rejects(
    downloadArtifact(
      artifact(bytes, { sha256: "0".repeat(64) }),
      destination,
      () => undefined,
      async () =>
        response(bytes, "https://cdn.example/update.zip", {
          "content-length": String(bytes.length)
        })
    ),
    /signed digest/
  );
  await assert.rejects(access(destination));
  await assert.rejects(access(`${destination}.part-${process.pid}`));
});

test("declared and streamed size mismatches fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-download-"));
  const bytes = Buffer.from("update");
  await assert.rejects(
    downloadArtifact(
      artifact(bytes),
      join(directory, "declared.zip"),
      () => undefined,
      async () =>
        response(bytes, "https://cdn.example/update.zip", {
          "content-length": String(bytes.length + 1)
        })
    ),
    /size does not match/
  );
  await assert.rejects(
    downloadArtifact(
      artifact(bytes),
      join(directory, "streamed.zip"),
      () => undefined,
      async () => response(Buffer.concat([bytes, Buffer.from("extra")]))
    ),
    /exceeds its signed size/
  );
});

test("signature downloads enforce size, TLS after redirects, and timeout", async () => {
  await assert.rejects(
    downloadBytes(
      "https://downloads.example/bundle",
      4,
      async () =>
        response("12345", "https://cdn.example/bundle", { "content-length": "5" })
    ),
    /too large/
  );
  await assert.rejects(
    downloadBytes(
      "https://downloads.example/bundle",
      10,
      async () => response("{}", "http://attacker.example/bundle")
    ),
    /insecure URL/
  );
  await assert.rejects(
    downloadBytes(
      "https://downloads.example/bundle",
      10,
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("timed out", "AbortError"))
          );
        }),
      5
    ),
    /timed out/
  );
});

test("cached artifacts are rehashed rather than trusted by filename or length", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-update-download-"));
  const destination = join(directory, "update.zip");
  const expected = Buffer.from("expected");
  await writeFile(destination, Buffer.from("tampered"));
  assert.equal(
    await artifactMatches(
      destination,
      artifact(expected, { size: Buffer.byteLength("tampered") })
    ),
    false
  );
});
