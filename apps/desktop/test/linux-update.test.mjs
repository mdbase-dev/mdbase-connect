import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { stageDebApp, swapStagedApp, userOwnedAppDirectory } = require("../dist/main/linux-update.js");

const linux = process.platform === "linux";

function arMember(name, data) {
  const header = Buffer.alloc(60, " ");
  header.write(`${name}/`, 0, "latin1");
  header.write("0", 16, "latin1");
  header.write("0", 28, "latin1");
  header.write("0", 34, "latin1");
  header.write("100644", 40, "latin1");
  header.write(String(data.length), 48, "latin1");
  header.write("`\n", 58, "latin1");
  return Buffer.concat([header, data, data.length % 2 ? Buffer.from("\n") : Buffer.alloc(0)]);
}

/** A Debian archive shaped like the release package: the app under usr/lib/mdbase-connect. */
async function deb(directory, executable = "#!/bin/sh\necho new\n") {
  const root = join(directory, "root");
  const app = join(root, "usr/lib/mdbase-connect");
  await mkdir(join(app, "resources"), { recursive: true });
  await writeFile(join(app, "mdbase-connect"), executable, { mode: 0o755 });
  await writeFile(join(app, "resources/app.asar"), "new app");
  const data = zstdCompressSync(execFileSync("tar", ["-c", "-C", root, "."]));
  const path = join(directory, "update.deb");
  await writeFile(path, Buffer.concat([
    Buffer.from("!<arch>\n", "latin1"),
    arMember("debian-binary", Buffer.from("2.0\n")),
    arMember("control.tar.zst", zstdCompressSync(Buffer.alloc(0))),
    arMember("data.tar.zst", data)
  ]));
  return path;
}

async function installed(directory) {
  const app = join(directory, "opt/mdbase-connect");
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "mdbase-connect"), "#!/bin/sh\necho old\n", { mode: 0o755 });
  return app;
}

test("only an app folder the user owns and can replace updates itself", { skip: !linux }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-linux-update-"));
  const app = await installed(directory);
  assert.equal(userOwnedAppDirectory(join(app, "mdbase-connect"), process.getuid()), app);
  assert.equal(userOwnedAppDirectory(join(app, "mdbase-connect"), process.getuid() + 1), null);
  if (process.getuid() !== 0) assert.equal(userOwnedAppDirectory("/usr/bin/env", process.getuid()), null);
});

test("a verified package is staged beside the app and swapped in, keeping the previous app", { skip: !linux }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-linux-update-"));
  const app = await installed(directory);
  await stageDebApp(await deb(directory), app, new AbortController().signal);
  assert.equal(await readFile(join(app, "mdbase-connect"), "utf8"), "#!/bin/sh\necho old\n");
  await assert.rejects(stat(`${app}.unpacking`));

  await swapStagedApp(app);
  assert.equal(await readFile(join(app, "mdbase-connect"), "utf8"), "#!/bin/sh\necho new\n");
  assert.equal((await stat(join(app, "mdbase-connect"))).mode & 0o111, 0o111);
  assert.equal(await readFile(join(app, "resources/app.asar"), "utf8"), "new app");
  assert.equal(await readFile(`${app}.previous/mdbase-connect`, "utf8"), "#!/bin/sh\necho old\n");
  await assert.rejects(stat(`${app}.next`));
  await assert.rejects(swapStagedApp(app), /ENOENT/);
});

test("a package without the app, or not a Debian archive, is refused before anything moves", { skip: !linux }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-linux-update-"));
  const app = await installed(directory);
  const notDeb = join(directory, "not.deb");
  await writeFile(notDeb, "plain text");
  await assert.rejects(stageDebApp(notDeb, app, new AbortController().signal), /not a Debian archive/);

  const empty = join(directory, "empty");
  await mkdir(join(empty, "root"), { recursive: true });
  const data = zstdCompressSync(execFileSync("tar", ["-c", "-C", join(empty, "root"), "."]));
  const hollow = join(directory, "hollow.deb");
  await writeFile(hollow, Buffer.concat([Buffer.from("!<arch>\n", "latin1"), arMember("data.tar.zst", data)]));
  await assert.rejects(stageDebApp(hollow, app, new AbortController().signal), /does not contain the mdbase connect app/);
  await assert.rejects(stat(`${app}.next`));
  await assert.rejects(stat(`${app}.unpacking`));
  assert.equal(await readFile(join(app, "mdbase-connect"), "utf8"), "#!/bin/sh\necho old\n");
});
