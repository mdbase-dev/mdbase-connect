import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/install-linux.sh");
const runnable = process.platform === "linux" && process.getuid() !== 0
  && spawnSync("zstd", ["--version"]).status === 0;

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

/**
 * A package shaped like the release .deb. Its app records how it was run, and
 * `--mdbase-update` installs a fake daemon runtime where its bundled CLI says
 * the state directory is.
 */
async function deb(directory, label, state, executable) {
  const root = join(directory, `root-${label}`);
  const app = join(root, "usr/lib/mdbase-connect");
  await mkdir(join(app, "resources/mdbase-next"), { recursive: true });
  await mkdir(join(root, "usr/share/pixmaps"), { recursive: true });
  if (executable) {
    await copyFile(executable, join(app, "mdbase-connect"));
  } else {
    await writeFile(join(app, "mdbase-connect"), [
      "#!/bin/sh",
      `echo "${label} $*" >> "${join(directory, "runs.log")}"`,
      `mkdir -p "${state}/runtime" && printf '#!/bin/sh\\n' > "${state}/runtime/mdbase" && chmod +x "${state}/runtime/mdbase"`,
      ""
    ].join("\n"), { mode: 0o755 });
  }
  await writeFile(join(app, "resources/mdbase-next/mdbase"),
    `#!/bin/sh\necho '{"target":"installed_service","state_dir":"${state}","control":null}'\n`, { mode: 0o755 });
  await writeFile(join(app, "VERSION"), label);
  await writeFile(join(root, "usr/share/pixmaps/mdbase-connect.png"), "png");
  const data = zstdCompressSync(execFileSync("tar", ["-c", "-C", root, "."], { maxBuffer: 256 * 1024 * 1024 }));
  const path = join(directory, `${label}.deb`);
  // An odd-length first member exercises the archive's padding.
  await writeFile(path, Buffer.concat([
    Buffer.from("!<arch>\n", "latin1"),
    arMember("debian-binary", Buffer.from("2.0\n\n\n")),
    arMember("control.tar.zst", zstdCompressSync(Buffer.from("control"))),
    arMember("data.tar.zst", data)
  ]));
  return path;
}

function install(prefix, ...args) {
  return spawnSync("sh", [script, "--prefix", prefix, ...args], { encoding: "utf8" });
}

test("the install script installs the app for the user, its launcher, commands and daemon", { skip: !runnable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-install-"));
  const prefix = join(directory, "home/.local");
  const state = join(directory, "state");
  const app = join(prefix, "opt/mdbase-connect");

  const first = install(prefix, "--deb", await deb(directory, "one", state));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(await readFile(join(app, "VERSION"), "utf8"), "one");
  assert.equal(await readFile(join(directory, "runs.log"), "utf8"), "one --mdbase-update\n");
  const entry = await readFile(join(prefix, "share/applications/mdbase-connect.desktop"), "utf8");
  assert.match(entry, new RegExp(`^Exec="${app}/mdbase-connect" %U$`, "m"));
  assert.match(entry, /^MimeType=x-scheme-handler\/mdbase-connect;$/m);
  assert.equal(await readFile(join(prefix, "share/icons/hicolor/512x512/apps/mdbase-connect.png"), "utf8"), "png");
  assert.equal(await readlink(join(prefix, "bin/mdbase-connect")), join(app, "mdbase-connect"));
  assert.equal(await readlink(join(prefix, "bin/mdbase")), join(state, "runtime/mdbase"));

  // Again with a newer package: the old app is kept, a staged update and a taken
  // command name are left alone or cleared as they should be.
  await mkdir(`${app}.next`);
  await rm(join(prefix, "bin/mdbase"));
  await writeFile(join(prefix, "bin/mdbase"), "someone else's");
  const second = install(prefix, "--deb", await deb(directory, "two", state));
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(join(app, "VERSION"), "utf8"), "two");
  assert.equal(await readFile(join(`${app}.previous`, "VERSION"), "utf8"), "one");
  await assert.rejects(stat(`${app}.next`));
  assert.equal(await readFile(join(prefix, "bin/mdbase"), "utf8"), "someone else's");
  assert.match(second.stderr, /bin\/mdbase already exists, so it was left as it is/);
  assert.equal((await lstat(join(prefix, "bin/mdbase-connect"))).isSymbolicLink(), true);

  // Not a package: nothing changes.
  const junk = join(directory, "junk.deb");
  await writeFile(junk, "not an archive");
  const bad = install(prefix, "--deb", junk);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /is not a Debian package/);
  assert.equal(await readFile(join(app, "VERSION"), "utf8"), "two");
  assert.equal(await readFile(join(`${app}.previous`, "VERSION"), "utf8"), "one");
});

test("the install script leaves a running app alone", { skip: !runnable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-install-running-"));
  const prefix = join(directory, "local");
  const state = join(directory, "state");
  // A real executable stands in for the app, so the process's /proc exe is the
  // app's path (a script's would be its interpreter). A shell runs under any name.
  const shell = await realpath("/bin/sh");
  const first = install(prefix, "--no-update", "--deb", await deb(directory, "one", state, shell));
  assert.equal(first.status, 0, first.stderr);
  // `; :` keeps the shell from exec-ing sleep in its place.
  const running = spawn(join(prefix, "opt/mdbase-connect/mdbase-connect"), ["-c", "sleep 30; :"]);
  try {
    await new Promise((resolve) => running.once("spawn", resolve));
    const second = install(prefix, "--no-update", "--deb", await deb(directory, "two", state));
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /mdbase connect is running/);
    assert.equal(await readFile(join(prefix, "opt/mdbase-connect/VERSION"), "utf8"), "one");
  } finally {
    running.kill();
  }
});
