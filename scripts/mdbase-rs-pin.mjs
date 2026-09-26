#!/usr/bin/env node
// Manage deploy/docker/mdbase-rs-revision, the engine revision every image,
// CI lane and release binds to.
//
//   pin:mdbase-rs <rev>    pin a pushed mdbase-rs commit (resolved through ../mdbase-rs)
//   check:mdbase-rs-pin    require the pin to be on mdbase-rs main (run by the merge queue)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repository = "callumalpass/mdbase-rs";
const root = resolve(import.meta.dirname, "..");
const pinFile = resolve(root, "deploy/docker/mdbase-rs-revision");
const [command, revision] = process.argv.slice(2);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (command === "set" && revision) {
  const sibling = resolve(root, "../mdbase-rs");
  const git = (...args) => execFileSync("git", ["-C", sibling, ...args], { encoding: "utf8" }).trim();
  git("fetch", "--quiet", "origin");
  let commit;
  try {
    commit = git("rev-parse", "--verify", `${revision}^{commit}`);
  } catch {
    fail(`${revision} is not a commit in ../mdbase-rs.`);
  }
  if (!git("branch", "--remotes", "--contains", commit)) {
    fail(`${commit} is not on any pushed mdbase-rs branch; push it first so CI can check it out.`);
  }
  writeFileSync(pinFile, `${commit}\n`);
  console.log(`Pinned mdbase-rs ${commit}.`);
  console.log("It must be on mdbase-rs main before this change can merge (check:mdbase-rs-pin).");
} else if (command === "check-main" && !revision) {
  const pin = readFileSync(pinFile, "utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(pin)) fail(`${pinFile} must hold one full commit SHA.`);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com/repos/${repository}/compare/main...${pin}`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) }
  });
  if (!response.ok) fail(`Could not compare ${pin} with ${repository} main: HTTP ${response.status}.`);
  const { status } = await response.json();
  // "behind" or "identical": main contains the pin, so it stays reachable after branch cleanup.
  if (status !== "behind" && status !== "identical") {
    fail(`mdbase-rs ${pin} is not on ${repository} main (${status}). Merge the engine change first, ` +
      "with a merge that keeps this commit, or pin the merged commit.");
  }
  console.log(`mdbase-rs ${pin} is on ${repository} main.`);
} else {
  fail("usage: mdbase-rs-pin.mjs set <revision> | check-main");
}
