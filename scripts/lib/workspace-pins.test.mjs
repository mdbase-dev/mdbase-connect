import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateWorkspacePins } from "./workspace-pins.mjs";

const SPEC = "https://github.com/mdbase-dev/mdbase-spec.git";
const PINNED = "362953e2644b07a7b61f92068a27ac6f917ee5c1";
const OLDER = "b133c8c24531d793e9ca0dbc93cb7a3b55d01776";

/** Builds a parent directory holding a workspace and its sibling checkouts. */
async function workspace(files) {
  const parent = await mkdtemp(path.join(tmpdir(), "mdbase-connect-pins-"));
  for (const [relative, source] of Object.entries(files)) {
    const target = path.join(parent, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  return parent;
}

/** Marks a directory as a repository root without running git. */
async function repository(parent, name) {
  await mkdir(path.join(parent, name, ".git"), { recursive: true });
}

function stubGit(state) {
  return async (repositoryPath, args) => {
    const name = path.basename(repositoryPath);
    const entry = state[name];
    if (!entry) throw new Error(`no stub for ${name}`);
    if (args[0] === "rev-parse") return entry.head;
    if (args[0] === "status") return entry.status ?? "";
    if (args[0] === "rev-list") return entry.counts ?? "0\t0";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

const dependency = (name, rev) =>
  `${name} = { version = "0.1.0", git = "${SPEC}", rev = "${rev}" }\n`;

test("passes when every sibling is at its pinned revision and clean", async (t) => {
  const parent = await workspace({
    "connect/Cargo.toml": `[dependencies]\n${dependency("mdbase-interop", PINNED)}mdbase = { path = "../mdbase-rs" }\n`,
    "mdbase-rs/Cargo.toml": "[package]\nname = \"mdbase\"\n",
    "mdbase-rs/crates/runtime/Cargo.toml": `[dependencies]\n${dependency("mdbase-interop", PINNED)}`
  });
  await repository(parent, "mdbase-rs");
  await repository(parent, "mdbase-spec");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await evaluateWorkspacePins(path.join(parent, "connect"), {
    git: stubGit({ "mdbase-spec": { head: PINNED, status: "" } })
  });

  assert.deepEqual(result.failures, []);
});

test("reports a sibling pinning a different revision of the same crate", async (t) => {
  // The build failure this produces is a type mismatch between two copies of
  // one crate, which names neither the repository nor the revision.
  const parent = await workspace({
    "connect/Cargo.toml": `[dependencies]\n${dependency("mdbase-interop", PINNED)}mdbase = { path = "../mdbase-rs" }\n`,
    "mdbase-rs/Cargo.toml": "[package]\nname = \"mdbase\"\n",
    "mdbase-rs/crates/runtime/Cargo.toml": `[dependencies]\n${dependency("mdbase-interop", OLDER)}`
  });
  await repository(parent, "mdbase-rs");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await evaluateWorkspacePins(path.join(parent, "connect"), {
    git: stubGit({})
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /mdbase-interop is pinned to 2 different revisions/);
  assert.match(result.failures[0], /362953e/);
  assert.match(result.failures[0], /b133c8c/);
  assert.match(result.failures[0], /mdbase-rs\/crates\/runtime\/Cargo\.toml:2/);
});

test("reports a sibling checkout behind its pin, with the command that fixes it", async (t) => {
  const parent = await workspace({
    "connect/Cargo.toml": `[dependencies]\n${dependency("mdbase-interop", PINNED)}`
  });
  await repository(parent, "mdbase-spec");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await evaluateWorkspacePins(path.join(parent, "connect"), {
    git: stubGit({ "mdbase-spec": { head: "fb07d04", counts: "4\t0", status: "" } })
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /4 commit\(s\) behind the pin/);
  assert.match(result.failures[0], /fix: git -C \.\.\/mdbase-spec checkout 362953e/);
});

test("reports modifications to a checkout pinned at an exact revision", async (t) => {
  // Tests read this working tree as fixtures, so a local edit silently changes
  // what they assert against.
  const parent = await workspace({
    "connect/Cargo.toml": `[dependencies]\n${dependency("mdbase-interop", PINNED)}`
  });
  await repository(parent, "mdbase-spec");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await evaluateWorkspacePins(path.join(parent, "connect"), {
    git: stubGit({
      "mdbase-spec": { head: PINNED, status: " M examples/v0.3/canvas-runtime/mdbase.yaml" }
    })
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /has 1 modified file/);
  assert.match(result.failures[0], /canvas-runtime/);
});

test("reports a wrong revision and a dirty tree together", async (t) => {
  // Modifications survive `git checkout`, so fixing only the revision leaves
  // the tree still not matching the pinned content.
  const parent = await workspace({
    "connect/Cargo.toml": `[dependencies]\n${dependency("mdbase-interop", PINNED)}`
  });
  await repository(parent, "mdbase-spec");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await evaluateWorkspacePins(path.join(parent, "connect"), {
    git: stubGit({ "mdbase-spec": { head: "fb07d04", counts: "4\t0", status: " M a.yaml" } })
  });

  assert.equal(result.failures.length, 2);
});

test("resolves a dependency path against its own manifest, not the workspace root", async (t) => {
  // A crate nested three levels down writes `../../../sibling`. Resolving that
  // from the root instead reports every such dependency as missing.
  const parent = await workspace({
    "connect/Cargo.toml": "[workspace]\n",
    "connect/crates/cli/Cargo.toml":
      "[dependencies]\nmdbase-command = { path = \"../../../mdbase-rs/crates/command\" }\n",
    "mdbase-rs/Cargo.toml": "[package]\nname = \"mdbase\"\n",
    "mdbase-rs/crates/command/Cargo.toml": "[package]\nname = \"mdbase-command\"\n"
  });
  await repository(parent, "mdbase-rs");
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await evaluateWorkspacePins(path.join(parent, "connect"), {
    git: stubGit({})
  });

  assert.deepEqual(result.failures, []);
});

test("reports a path dependency whose checkout is absent", async (t) => {
  const parent = await workspace({
    "connect/Cargo.toml": "[dependencies]\nmdbase = { path = \"../mdbase-rs\" }\n"
  });
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await evaluateWorkspacePins(path.join(parent, "connect"), {
    git: stubGit({})
  });

  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /does not exist/);
});

test("ignores a git dependency with no sibling checkout to compare", async (t) => {
  // Cargo vendors it, so there is nothing on disk that can disagree.
  const parent = await workspace({
    "connect/Cargo.toml": `[dependencies]\n${dependency("mdbase-interop", PINNED)}`
  });
  t.after(() => rm(parent, { recursive: true, force: true }));

  const result = await evaluateWorkspacePins(path.join(parent, "connect"), {
    git: stubGit({})
  });

  assert.deepEqual(result.failures, []);
});
