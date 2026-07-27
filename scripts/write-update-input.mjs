#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const options = argumentsFrom(process.argv.slice(2));
const directory = required(options, "directory");
const platform = required(options, "platform");
const arch = required(options, "arch");
const mode = required(options, "mode");
const actionUrl = required(options, "action-url");
const artifacts = list(options, "artifact");

if (!["macos", "windows", "linux"].includes(platform)) fail(`Unsupported platform ${platform}.`);
if (!["arm64", "x64"].includes(arch)) fail(`Unsupported architecture ${arch}.`);
if (!["automatic", "store", "manual"].includes(mode)) fail(`Unsupported update mode ${mode}.`);
if (mode !== "store" && artifacts.length === 0) fail("Non-Store targets require an artifact.");

for (const artifact of artifacts) {
  if (artifact !== basename(artifact)) fail(`Unsafe artifact name ${artifact}.`);
  await access(join(directory, artifact));
  await access(join(directory, `${artifact}.sigstore.json`));
}

const output = join(directory, `update-input-${platform}-${arch}.json`);
await writeFile(
  output,
  `${JSON.stringify(
    {
      schema_version: 1,
      platform,
      arch,
      mode,
      action_url: actionUrl,
      artifacts
    },
    null,
    2
  )}\n`,
  { encoding: "utf8", flag: "wx" }
);
console.log(output);

function argumentsFrom(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("Arguments must be --name value pairs.");
    const key = name.slice(2);
    const entries = result.get(key) ?? [];
    entries.push(value);
    result.set(key, entries);
  }
  return result;
}

function required(values, name) {
  const entries = values.get(name);
  if (!entries || entries.length !== 1 || !entries[0]) fail(`--${name} is required once.`);
  return entries[0];
}

function list(values, name) {
  return values.get(name) ?? [];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
