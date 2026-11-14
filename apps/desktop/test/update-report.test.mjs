import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { updateReport, updateReportPath, writeUpdateReport } = require("../dist/main/update-report.js");

const base = {
  current_version: "0.1.0-beta.185",
  channel: "beta",
  checked_at: "2026-11-14T03:00:00.000Z",
  message: "",
  can_check: true,
  can_install: false
};
const release = "https://github.com/mdbase-dev/mdbase-connect/releases/tag/v0.1.0-beta.208";

test("a finished check reports the newer release and how this installation installs it", () => {
  const options = { background: true, store: false };
  assert.deepEqual(updateReport({ ...base, phase: "idle" }, options), {
    schema_version: 1, app_version: "0.1.0-beta.185", checked_at: base.checked_at, background: true
  });
  assert.deepEqual(updateReport({ ...base, phase: "ready", target_version: "0.1.0-beta.208", release_url: release }, options).available,
    { version: "0.1.0-beta.208", install: "restart", release_url: release });
  assert.deepEqual(updateReport({ ...base, phase: "external", target_version: "0.1.0-beta.208", required: true }, { background: false, store: false }).available,
    { version: "0.1.0-beta.208", install: "package", required: true });
  assert.equal(updateReport({ ...base, phase: "external", target_version: "0.1.0-beta.208" }, { background: false, store: true }).available.install, "store");
  // Rolling out to other installations: not available here yet.
  assert.equal(updateReport({ ...base, phase: "deferred", target_version: "0.1.0-beta.208" }, options).available, undefined);
  assert.equal(updateReport({ ...base, checked_at: undefined, phase: "idle" }, options), null);
});

test("the report replaces the previous one privately in the daemon's packaging directory", async () => {
  const state = await mkdtemp(join(tmpdir(), "mdbase-update-report-"));
  const report = updateReport({ ...base, phase: "idle" }, { background: false, store: false });
  await writeUpdateReport(state, report);
  await writeUpdateReport(state, { ...report, background: true });
  assert.equal(updateReportPath(state), join(state, "updates", "desktop.json"));
  assert.deepEqual(JSON.parse(await readFile(updateReportPath(state), "utf8")), { ...report, background: true });
  assert.equal((await stat(updateReportPath(state))).mode & 0o777, 0o600);
  assert.equal((await stat(join(state, "updates"))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(state, "updates")), ["desktop.json"]);
});
