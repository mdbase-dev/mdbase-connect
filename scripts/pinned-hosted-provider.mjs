#!/usr/bin/env node

// Copies the hosted-provider binary out of the image pinned in
// deploy/docker/hosted-provider-image, so the provider system suite can run
// against the image production runs instead of a build of this checkout.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const extractionRoot = join(repoRoot, "target", "pinned-hosted-provider");
const binaryName = "mdbase-connect-hosted-provider";

export async function pinnedProviderImage() {
  const image = (await readFile(join(repoRoot, "deploy", "docker", "hosted-provider-image"), "utf8")).trim();
  const digest = /^[a-z0-9./-]+@sha256:([0-9a-f]{64})$/.exec(image)?.[1];
  if (!digest) throw new Error(`deploy/docker/hosted-provider-image must hold one image@sha256 reference, not ${JSON.stringify(image)}`);
  return { image, digest };
}

// The path is keyed by digest, so moving the pin never reuses an older binary.
export async function pinnedProviderBinary() {
  const { digest } = await pinnedProviderImage();
  return join(extractionRoot, digest, binaryName);
}

async function extract() {
  const { image, digest } = await pinnedProviderImage();
  const binary = await pinnedProviderBinary();
  for (const entry of await readdir(extractionRoot).catch(() => [])) {
    if (entry !== digest) await rm(join(extractionRoot, entry), { recursive: true, force: true });
  }
  if (await access(binary).then(() => true, () => false)) {
    process.stdout.write(`${binary} already holds ${image}\n`);
    return;
  }
  await mkdir(join(extractionRoot, digest), { recursive: true });
  await execute("docker", ["pull", "--quiet", image]);
  const container = `mdbase-pinned-provider-${randomUUID()}`;
  const partial = `${binary}.partial`;
  await execute("docker", ["create", "--name", container, image]);
  try {
    await execute("docker", ["cp", `${container}:/usr/local/bin/${binaryName}`, partial]);
  } finally {
    await execute("docker", ["rm", container]);
  }
  await rename(partial, binary);
  process.stdout.write(`copied ${binaryName} from ${image}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await extract();
