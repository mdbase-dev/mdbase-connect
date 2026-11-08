import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutProductionCommit, contractSensitive, nextBetaVersion, proveCompatibility, repository, requireRunning } from "./continuous-client-release.mjs";

const sha = value => value.repeat(40);
const selectionEnv = { GITHUB_REPOSITORY: repository, GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha("f") };
function selection({ commits = [sha("c"), sha("b"), sha("a")], green = [sha("b"), sha("a")], production = sha("d"), provider = sha("c"), qualifyError } = {}) {
  const calls = [];
  let head = selectionEnv.GITHUB_SHA;
  return { calls, dependencies: {
    readProduction: async () => ({ sha: production, providerSha: provider }),
    runGit: (...args) => {
      calls.push(args);
      if (args[0] === "merge-base") {
        assert.deepEqual(args, ["merge-base", "--octopus", "origin/main", production, provider]);
        return commits[0];
      }
      if (args[0] === "rev-list") {
        assert.deepEqual(args, ["rev-list", "--first-parent", commits[0]]);
        return commits.join("\n");
      }
      if (args[0] === "checkout") head = args[2];
      return "";
    },
    readApi: path => {
      const commit = new URLSearchParams(path.split("?")[1]).get("head_sha");
      assert.match(path, /event=push&branch=main/);
      calls.push(["api", commit]);
      const run = { head_sha: commit, head_branch: "main", event: "push", status: "completed", conclusion: "success", path: ".github/workflows/server-ci.yml" };
      return { workflow_runs: green.includes(commit) ? [run] : [
        { ...run, head_sha: sha("e") }, { ...run, head_branch: "other" }, { ...run, event: "pull_request" },
        { ...run, status: "in_progress" }, { ...run, conclusion: "failure" }, { ...run, path: ".github/workflows/runtime-ci.yml" }
      ] };
    },
    qualify: commit => {
      assert.equal(head, commit, "full qualification must verify the selected checkout, not the workflow SHA");
      calls.push(["qualify", commit]);
      if (qualifyError) throw qualifyError;
    }
  } };
}

test("newest green common production/main ancestor wins even when main and the wakeup SHA move ahead", async () => {
  for (const workflowSha of [sha("f"), sha("e")]) {
    const fixture = selection();
    assert.equal(await checkoutProductionCommit({ ...selectionEnv, GITHUB_SHA: workflowSha }, fixture.dependencies), sha("b"));
    assert.deepEqual(fixture.calls.slice(-2), [["checkout", "--detach", sha("b")], ["qualify", sha("b")]]);
    assert(!fixture.calls.some(args => args[0] === "api" && [sha("d"), sha("e"), sha("f")].includes(args[1])));
  }
});

test("production head may release immediately; provider skew caps selection and green badges never replace full CI", async () => {
  const fixture = selection({ green: [sha("c")] });
  assert.equal(await checkoutProductionCommit(selectionEnv, fixture.dependencies), sha("c"));
  const failed = selection({ qualifyError: new Error("missing full artifact") });
  await assert.rejects(checkoutProductionCommit(selectionEnv, failed.dependencies), /missing full artifact/);
  assert.equal(failed.calls.filter(call => call[0] === "qualify").length, 1);
  const none = selection({ green: [] });
  await assert.rejects(checkoutProductionCommit(selectionEnv, none.dependencies), /No green main commit/);
  assert(!none.calls.some(call => call[0] === "checkout"));
});

test("selection fails closed on wrong workflow origin, unhealthy production, invalid identity or unavailable CI", async () => {
  for (const changes of [{ GITHUB_REF: "refs/tags/v1" }, { GITHUB_REPOSITORY: "other/repo" }]) {
    await assert.rejects(checkoutProductionCommit({ ...selectionEnv, ...changes }, selection().dependencies), /main workflow/);
  }
  await assert.rejects(checkoutProductionCommit(selectionEnv, selection({ provider: "main" }).dependencies), /full commit/);
  const fixture = selection();
  await assert.rejects(checkoutProductionCommit(selectionEnv, { ...fixture.dependencies, readProduction: async () => { throw new Error("not ready"); } }), /not ready/);
  await assert.rejects(checkoutProductionCommit(selectionEnv, { ...fixture.dependencies, readApi: () => { throw new Error("API unavailable"); } }), /API unavailable/);
});

test("real Git ancestry selects the production-contained source, not main's newer contract change", async t => {
  const directory = mkdtempSync(join(tmpdir(), "client-production-selection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runGit = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  runGit("init", "--initial-branch=main");
  runGit("config", "user.email", "test@example.invalid");
  runGit("config", "user.name", "Release test");
  const commits = [];
  for (const name of ["baseline", "provider", "server", "new main contract", "main moves again"]) {
    writeFileSync(join(directory, "contract.ts"), `${name}\n`);
    runGit("add", "contract.ts");
    runGit("commit", "-m", name);
    commits.push(runGit("rev-parse", "HEAD"));
  }
  runGit("remote", "add", "origin", directory);
  const selected = await checkoutProductionCommit({ ...selectionEnv, GITHUB_SHA: commits[3] }, {
    runGit, readProduction: async () => ({ sha: commits[2], providerSha: commits[1] }),
    readApi: path => ({ workflow_runs: [{ head_sha: new URLSearchParams(path.split("?")[1]).get("head_sha"),
      head_branch: "main", event: "push", status: "completed", conclusion: "success", path: ".github/workflows/server-ci.yml" }] }),
    qualify: commit => assert.equal(runGit("rev-parse", "HEAD"), commit)
  });
  assert.equal(selected, commits[1]);
  for (const production of [commits[1], commits[2]]) {
    assert.equal(proveCompatibility(selected, production, runGit).reason, "production-contains-candidate");
  }
  assert.equal(runGit("rev-parse", "origin/main"), commits[4]);
});

test("CI beta allocation advances every published and source version without numeric overflow", () => {
  assert.equal(nextBetaVersion(["0.1.0-beta.9", "0.1.0-beta.152", "0.1.0-beta.101"]), "0.1.0-beta.153");
  assert.equal(nextBetaVersion(["0.0.1-next.0", "0.1.0-beta.152"]), "0.1.0-beta.153");
  assert.equal(nextBetaVersion(["0.1.0-beta.9007199254740999"]), "0.1.0-beta.9007199254741000");
  for (const version of ["0.1.0", "0.2.0-beta.1", "garbage", "0.1.0-beta.01"]) {
    assert.throws(() => nextBetaVersion([version]), /release-owner review/);
  }
});

test("unknown, authorization, transport, trust and policy sources are contract-sensitive", () => {
  for (const path of ["packages/protocol/src/auth.ts", "packages/client/src/grants.ts", "runtime/crates/wire/src/lib.rs",
    "runtime/packages/sdk/src/index.ts", "config/next-trust/production.json", "services/server/src/main.ts",
    "deploy/docker/mdbase-rs-revision", "new-contract/source.ts", "scripts/build-release-trust-bundle.mts",
    "apps/desktop/src/main/main.ts", "apps/editor/src/gateway.ts", "packages/ui/src/button.tsx",
    "packages/sync/src/index.ts", "packages/webhooks/src/index.ts",
    "packages/ui/locales/de/index.ts", "pnpm-lock.yaml"]) {
    assert.equal(contractSensitive(path), true, path);
  }
  for (const path of ["apps/desktop/assets/icon.png", "apps/editor/src/styles.css", "docs/releasing.md",
    "runtime/crates/wire/tests/protocol.rs", "packages/client/src/grants.test.ts", "DESIGN.md", "apps/editor/DESIGN.md",
    "apps/desktop/src/locales/de/messages.po", "apps/portal/src/locales/de/messages.po",
    "apps/editor/src/i18n/locales/de/messages.po", "packages/app-ui/src/locales/de/messages.po",
    "packages/ui/locales/de/messages.po"]) {
    assert.equal(contractSensitive(path), false, path);
  }
});

test("stop switch fails closed on true and invalid values", () => {
  for (const value of [undefined, "", "false"]) requireRunning(value);
  for (const value of ["true", "False", "0", "unknown"]) assert.throws(() => requireRunning(value), /stopped/);
});

test("production ancestry or an exact off-axis diff is required, not version equality", () => {
  const candidate = "a".repeat(40);
  const production = "b".repeat(40);
  const run = (paths, status = 1) => (...args) => {
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") throw Object.assign(new Error("ancestry"), { status });
    if (args[0] === "diff") {
      assert.deepEqual(args.slice(1), ["--no-renames", "--name-only", "-z", production, candidate]);
      return paths.join("\0");
    }
    return "";
  };
  assert.equal(proveCompatibility(candidate, production, () => "").reason, "production-contains-candidate");
  assert.equal(proveCompatibility(candidate, production, run(["apps/editor/src/styles.css"])).reason, "unchanged-contract-axis");
  assert.throws(() => proveCompatibility(candidate, production, run(["apps/desktop/src/main/main.ts"])), /server-facing contract/);
  assert.throws(() => proveCompatibility(candidate, production, run(["packages/protocol/src/auth.ts"])), /server-facing contract/);
  assert.throws(() => proveCompatibility(candidate, production, run([], 128)), /ancestry/);
  assert.throws(() => proveCompatibility("main", production, run([])), /full commit/);
});
