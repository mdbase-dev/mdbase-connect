import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { ensureNextDaemon, bundledNextDaemon, nextDaemonRunner } = require("../dist/main/next-daemon.js");
const version = "0.2.0-beta.1";
const ready = (v = version) => ({ registration: "installed", binary_version: v, readiness: { ready: true, binary_version: v } });
function runner(results) {
  const calls = [];
  return { calls, run: async (args) => { calls.push(args); assert.ok(results.length); return results.shift(); } };
}

test("absent, stale, invalid, and older installations install the bundled version", async () => {
  for (const status of [ { registration: "absent" }, { registration: "stale" },
    ready("0.1.0"), ready("bad version") ]) {
    const { run, calls } = runner([{ exitCode: 3, value: status }, { exitCode: 0, value: ready() }]);
    assert.deepEqual(await ensureNextDaemon(run, version), { outcome: "installed", version });
    assert.deepEqual(calls, [["--json", "service", "status"], ["--json", "service", "install"]]);
  }
});

test("equal and newer installations are never overwritten; stopped service is started", async () => {
  for (const installed of [version, "0.2.0-beta.2", "0.2.0"]) {
    const active = runner([{ exitCode: 0, value: ready(installed) }]);
    assert.deepEqual(await ensureNextDaemon(active.run, version), { outcome: "already_installed", version: installed, started: false });
    assert.equal(active.calls.length, 1);
    const stopped = runner([
      { exitCode: 0, value: { ...ready(installed), readiness: null } },
      { exitCode: 0, value: ready(installed) }
    ]);
    assert.deepEqual(await ensureNextDaemon(stopped.run, version), { outcome: "already_installed", version: installed, started: true });
    assert.deepEqual(stopped.calls[1], ["--json", "service", "start"]);
  }
});

test("status, start, install and readiness failures remain failures", async () => {
  for (const status of [{ exitCode: 1, value: null }, { exitCode: 2, value: null }, { exitCode: 0, value: null }]) {
    await assert.rejects(ensureNextDaemon(runner([status]).run, version));
  }
  for (const result of [{ exitCode: 1, value: null }, { exitCode: 2, value: null },
    { exitCode: 3, value: ready() }, { exitCode: 0, value: ready("0.1.0") },
    { exitCode: 0, value: null }, { exitCode: 0, value: { ...ready(), registration: "absent" } },
    { exitCode: 0, value: { ...ready(), readiness: { ready: false, binary_version: version } } }]) {
    await assert.rejects(ensureNextDaemon(runner([{ exitCode: 0, value: { registration: "absent" } }, result]).run, version));
    await assert.rejects(ensureNextDaemon(runner([{ exitCode: 0, value: { ...ready(), readiness: null } }, result]).run, version));
  }
});

test("a swapped-in bundle that does not become ready is rolled back to mdbase.previous", async () => {
  const previous = "0.1.9";
  const { run, calls } = runner([
    { exitCode: 0, value: ready(previous) },
    { exitCode: 3, value: { registration: "installed", binary_version: version, readiness: null } },
    { exitCode: 3, value: { registration: "installed", binary_version: version, readiness: null } }
  ]);
  const back = runner([{ exitCode: 0, value: ready(previous) }]);
  const outcome = await ensureNextDaemon(run, version, { rollback: back.run });
  assert.deepEqual(outcome, { outcome: "rolled_back", version: previous, failed: version,
    reason: "The mdbase daemon was installed but did not become ready." });
  assert.deepEqual(calls.at(-1), ["--json", "service", "status"]);
  assert.deepEqual(back.calls, [["--json", "service", "install"]]);

  // Held back: the next launch keeps the restored daemon instead of retrying.
  const held = runner([{ exitCode: 0, value: ready(previous) }]);
  assert.deepEqual(await ensureNextDaemon(held.run, version, { heldBack: version, rollback: back.run }),
    { outcome: "already_installed", version: previous, started: false });

  // No swap happened (the runtime is still the old copy): nothing to roll back.
  const unswapped = runner([
    { exitCode: 0, value: ready(previous) },
    { exitCode: 1, value: null },
    { exitCode: 0, value: ready(previous) }
  ]);
  const untouched = runner([]);
  await assert.rejects(ensureNextDaemon(unswapped.run, version, { rollback: untouched.run }), /exit 1/);
  assert.equal(untouched.calls.length, 0);

  // A failed restore is reported with the original failure.
  const broken = runner([
    { exitCode: 0, value: ready(previous) },
    { exitCode: 3, value: null },
    { exitCode: 3, value: { registration: "installed", binary_version: version, readiness: null } }
  ]);
  await assert.rejects(
    ensureNextDaemon(broken.run, version, { rollback: runner([{ exitCode: 3, value: null }]).run }),
    /did not become ready\. Restoring the previous mdbase daemon also failed/
  );
});

test("bundle lives beside the old runtime and requires a valid VERSION", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-next-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await bundledNextDaemon(directory, "linux"), null);
  await mkdir(join(directory, "mdbase-next"));
  const binary = join(directory, "mdbase-next", "mdbase");
  await writeFile(binary, "binary");
  await assert.rejects(bundledNextDaemon(directory, "linux"));
  await writeFile(join(directory, "mdbase-next", "VERSION"), `${version}\n`);
  assert.deepEqual(await bundledNextDaemon(directory, "linux"), { binary, version });
  await writeFile(join(directory, "mdbase-next", "VERSION"), "bad");
  await assert.rejects(bundledNextDaemon(directory, "linux"), /invalid version/);
});

test("CLI runner removes isolated profile environment and parses failures without throwing", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-next-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, "fake-mdbase");
  await writeFile(binary, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), isolated: process.env.MDBASE_HOME ?? null })); process.exit(3);\n`);
  await chmod(binary, 0o700);
  const environment = { ...process.env, MDBASE_HOME: "/isolated" };
  const result = await nextDaemonRunner(binary, environment)(["--json", "service", "status"]);
  assert.equal(result.exitCode, 3);
  assert.deepEqual(result.value, { args: ["--json", "service", "status"], isolated: null });
  assert.equal(environment.MDBASE_HOME, "/isolated");
  assert.deepEqual(await nextDaemonRunner(join(directory, "missing"))([]), { exitCode: 1, value: null });
});
