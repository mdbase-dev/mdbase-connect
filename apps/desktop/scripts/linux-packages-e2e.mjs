import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = await mkdtemp(join(tmpdir(), "mdbase-package-lifecycle-"));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: root });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
try {
  run("docker", ["run", "--rm", "--volume", `${root}:/work:ro`, "--volume", `${output}:/output`,
    "--workdir", "/work", "node:24-bookworm", "sh", "-ec",
    "apt-get update && apt-get install -y fakeroot rpm && node apps/desktop/scripts/linux-package-fixtures.cjs"]);
  const artifacts = [];
  for (const version of ["0.0.2", "0.0.1"]) {
    for (const format of ["deb", "rpm"]) {
      const paths = JSON.parse(await readFile(join(output, version, `${format}.json`), "utf8"));
      if (paths.length !== 1) throw new Error(`Expected one ${format} fixture`);
      artifacts.push(join(output, paths[0].slice("/output/".length)));
    }
  }
  run(process.execPath, ["apps/desktop/scripts/verify-linux-packages.mjs", ...artifacts]);
} finally {
  // Container output is root-owned; remove it inside the same isolated mount.
  run("docker", ["run", "--rm", "--volume", `${output}:/output`, "node:24-bookworm",
    "sh", "-ec", "find /output -mindepth 1 -delete"]);
  await rm(output, { recursive: true });
}
