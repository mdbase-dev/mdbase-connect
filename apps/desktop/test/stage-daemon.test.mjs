import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageDaemon } from "../scripts/stage-daemon.mjs";

test("the bundled daemon is staged with its own reported version, and a mismatch is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mdbase-stage-daemon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "mdbase");
  await writeFile(binary, "daemon");
  const directory = join(root, "mdbase-next");
  const version = () => "0.2.0-beta.3";
  assert.deepEqual(await stageDaemon({ MDBN_DAEMON_BIN: binary }, { directory, platform: "linux", version }),
    { directory, version: "0.2.0-beta.3" });
  assert.equal(await readFile(join(directory, "mdbase"), "utf8"), "daemon");
  assert.equal(await readFile(join(directory, "VERSION"), "utf8"), "0.2.0-beta.3\n");
  await assert.rejects(stageDaemon({ MDBN_DAEMON_BIN: binary, MDBN_DAEMON_VERSION: "0.2.0" }, { directory, version }), /expected 0\.2\.0/);
  await assert.rejects(stageDaemon({ MDBN_DAEMON_BIN: "mdbase" }, { directory, version }), /MDBN_DAEMON_BIN/);
  await assert.rejects(stageDaemon({ MDBN_DAEMON_BIN: binary }, { directory, version: () => "dev" }), /valid version/);
});
