#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectsRoot = resolve(
  process.env.MDBASE_CONSUMER_PROJECTS_ROOT ?? resolve(repositoryRoot, "..")
);
const consumers = [
  ["TaskNotes", "tasknotes-app"],
  ["mdbase Reader", "mdbase-reader"],
  ["mdbase Workouts", "workout_tracker"],
  ["Pickle", "pickle-android"]
];
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8"
}).trim();
const sourcePackage = JSON.parse(
  await readFile(resolve(repositoryRoot, "packages/client/package.json"), "utf8")
);

const inventories = [];
for (const [product, checkout] of consumers) {
  inventories.push(await inspectConsumer(product, resolve(projectsRoot, checkout)));
}
inventories.push({
  product: "mdbase Editor (workspace)",
  revision: sourceRevision,
  version: sourcePackage.version,
  artifacts: ["workspace:packages/client"]
});

const revisions = new Set(inventories.map(({ revision }) => revision));
const versions = new Set(inventories.map(({ version }) => version));
if (revisions.size !== 1 || versions.size !== 1) {
  throw new Error(
    "Controlled consumers do not use one Connect artifact build: "
      + inventories.map(({ product, version, revision }) =>
        `${product}=${version}@${revision.slice(0, 12)}`).join(", ")
  );
}
if ([...revisions][0] !== sourceRevision) {
  throw new Error(
    `Controlled consumers use ${[...revisions][0]}, not current Connect ${sourceRevision}.`
  );
}

for (const inventory of inventories) {
  process.stdout.write(
    `${inventory.product}\t${inventory.version}\t${inventory.revision}\t`
      + `${inventory.artifacts.join(",")}\n`
  );
}

async function inspectConsumer(product, checkout) {
  const vendor = resolve(checkout, "vendor");
  const manifestPath = resolve(vendor, "mdbase-connect-sdk.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schema_version !== 1 || !/^[0-9a-f]{40}$/u.test(manifest.revision)) {
    throw new Error(`${product} has an invalid Connect artifact manifest.`);
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error(`${product} has no declared Connect artifacts.`);
  }
  const shortRevision = manifest.revision.slice(0, 12);
  const versions = new Set();
  const declaredFiles = new Set();
  for (const artifact of manifest.artifacts) {
    if (
      typeof artifact.package !== "string"
      || typeof artifact.file !== "string"
      || typeof artifact.bytes !== "number"
      || typeof artifact.sha512 !== "string"
    ) {
      throw new Error(`${product} has an invalid artifact entry.`);
    }
    if (!artifact.file.endsWith(`-${shortRevision}.tgz`)) {
      throw new Error(`${product} artifact ${artifact.file} is not from ${shortRevision}.`);
    }
    const version = artifact.file.match(
      /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-[0-9a-f]{12}\.tgz$/u
    )?.[1];
    if (!version) throw new Error(`${product} artifact ${artifact.file} has no parseable version.`);
    versions.add(version);
    if (declaredFiles.has(artifact.file)) {
      throw new Error(`${product} declares ${artifact.file} more than once.`);
    }
    declaredFiles.add(artifact.file);
    const artifactPath = resolve(vendor, artifact.file);
    const metadata = await stat(artifactPath);
    if (metadata.size !== artifact.bytes) {
      throw new Error(`${product} artifact ${artifact.file} has the wrong byte length.`);
    }
    const digest = createHash("sha512").update(await readFile(artifactPath)).digest("base64");
    if (digest !== artifact.sha512) {
      throw new Error(`${product} artifact ${artifact.file} fails SHA-512 verification.`);
    }
  }
  if (versions.size !== 1) {
    throw new Error(`${product} mixes Connect package versions: ${[...versions].join(", ")}.`);
  }

  const packageSource = (await readPackageSources(checkout)).join("\n");
  const [lockName, lockSource] = await readLockfile(checkout);
  const packageFiles = referencedArtifacts(packageSource);
  const lockFiles = referencedArtifacts(lockSource);
  assertReferences(product, "package.json", packageFiles, declaredFiles);
  assertReferences(product, lockName, lockFiles, declaredFiles);

  return {
    product,
    revision: manifest.revision,
    version: [...versions][0],
    artifacts: [...declaredFiles].sort()
  };
}

async function readPackageSources(checkout) {
  const sources = [await readFile(resolve(checkout, "package.json"), "utf8")];
  for (const workspaceDirectory of ["apps", "packages"]) {
    let entries;
    try {
      entries = await readdir(resolve(checkout, workspaceDirectory), {
        withFileTypes: true
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        sources.push(
          await readFile(
            resolve(checkout, workspaceDirectory, entry.name, "package.json"),
            "utf8"
          )
        );
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return sources;
}

async function readLockfile(checkout) {
  for (const name of ["pnpm-lock.yaml", "package-lock.json"]) {
    try {
      return [name, await readFile(resolve(checkout, name), "utf8")];
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`${checkout} has no supported lockfile.`);
}

function referencedArtifacts(source) {
  return new Set(source.match(/mdbase-dev-[A-Za-z0-9.-]+\.tgz/gu) ?? []);
}

function assertReferences(product, source, actual, declared) {
  if (actual.size === 0) throw new Error(`${product} ${source} references no Connect artifacts.`);
  const undeclared = [...actual].filter((file) => !declared.has(file));
  const unused = [...declared].filter((file) => !actual.has(file));
  if (undeclared.length > 0 || unused.length > 0) {
    throw new Error(
      `${product} ${source} and vendor manifest disagree; `
        + `undeclared=[${undeclared.join(", ")}], unused=[${unused.join(", ")}].`
    );
  }
}
