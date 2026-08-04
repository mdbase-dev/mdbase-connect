import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageDirectories = new Map([
  ["connect", "packages/client"],
  ["devkit", "packages/devkit"],
  ["protocol", "packages/protocol"],
  ["sync", "packages/sync"],
  ["pickle", "packages/pickle"],
  ["testing", "packages/testing"],
]);
const defaultPackages = ["connect", "devkit", "protocol", "sync", "testing"];

const options = parseArguments(process.argv.slice(2));
const destination = resolve(options.destination);
const revision = command("git", ["rev-parse", "HEAD"]).trim();
const shortRevision = revision.slice(0, 12);
const dirtyPackages = command("git", [
  "status",
  "--porcelain",
  "--",
  ...[...packageDirectories.values()],
]).trim();
if (dirtyPackages) {
  throw new Error(
    "Commit SDK package changes before packing consumer artifacts. Immutable artifacts must identify committed source.",
  );
}

command("pnpm", ["build"]);
const temporary = await mkdtemp(resolve(tmpdir(), "mdbase-connect-sdk-"));
const artifacts = [];
try {
  for (const packageName of options.packages) {
    const directory = packageDirectories.get(packageName);
    if (!directory) {
      throw new Error(
        `Unknown package ${packageName}. Choose from ${[...packageDirectories.keys()].join(", ")}.`,
      );
    }
    const output = command("pnpm", [
      "--dir",
      directory,
      "pack",
      "--pack-destination",
      temporary,
    ]).trim().split("\n").at(-1);
    if (!output) throw new Error(`pnpm did not report an artifact for ${packageName}.`);
    const source = resolve(output);
    const originalName = basename(source);
    const extension = ".tgz";
    const targetName = `${originalName.slice(0, -extension.length)}-${shortRevision}${extension}`;
    const target = resolve(destination, targetName);
    const bytes = await readFile(source);
    await cp(source, target);
    artifacts.push({
      package: packageName,
      file: targetName,
      bytes: bytes.length,
      sha512: createHash("sha512").update(bytes).digest("base64"),
    });
  }
  await writeFile(
    resolve(destination, "mdbase-connect-sdk.json"),
    `${JSON.stringify({
      schema_version: 1,
      repository: "https://github.com/mdbase-dev/mdbase-connect",
      revision,
      artifacts,
    }, null, 2)}\n`,
    { flag: "wx" },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

for (const artifact of artifacts) {
  process.stdout.write(`${artifact.package}: ${artifact.file}\n`);
}

function parseArguments(arguments_) {
  const destinationIndex = arguments_.indexOf("--destination");
  if (destinationIndex === -1 || !arguments_[destinationIndex + 1]) {
    throw new Error(
      "Usage: node scripts/pack-consumer-sdk.mjs --destination <vendor-directory> [--packages connect,devkit,protocol,sync,pickle,testing]",
    );
  }
  const packagesIndex = arguments_.indexOf("--packages");
  return {
    destination: arguments_[destinationIndex + 1],
    packages: packagesIndex === -1
      ? defaultPackages
      : arguments_[packagesIndex + 1]?.split(",").filter(Boolean) ?? [],
  };
}

function command(executable, arguments_) {
  const result = spawnSync(executable, arguments_, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed with exit ${result.status}.`);
  }
  return result.stdout;
}
