import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const context = fileURLToPath(new URL("../../test/fixtures/s3-images/", import.meta.url));
let pending;

// Test-only, fail-closed source builds. Never fall back to an unverified registry
// mirror or a mutable local tag. Consumers run the immutable build output IDs.
export function buildS3TestImages() {
  pending ??= build();
  return pending;
}

async function build() {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-s3-image-build-"));
  try {
    const images = {};
    for (const target of ["minio", "mc"]) {
      const iidfile = join(directory, `${target}.iid`);
      await new Promise((resolve, reject) => {
        const child = spawn("docker", [
          "build", "--pull", "--progress=plain", "--file", join(context, "Dockerfile"),
          "--target", target, "--iidfile", iidfile, context
        ], { stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`Pinned ${target} test image build failed (${signal ?? code}).`));
        });
      });
      const image = (await readFile(iidfile, "utf8")).trim();
      if (!/^sha256:[a-f0-9]{64}$/u.test(image)) {
        throw new Error(`Invalid ${target} test image build ID.`);
      }
      images[target] = image;
    }
    return Object.freeze(images);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
