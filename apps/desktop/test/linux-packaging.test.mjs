import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const config = require("../forge.config.cjs");

for (const service of ["server", "mcp"]) {
  test(`${service} Docker build includes workspace patches before installing`, async () => {
    const dockerfile = await readFile(new URL(`../../../deploy/docker/Dockerfile.${service}`, import.meta.url), "utf8");
    assert.match(dockerfile.split("RUN pnpm install")[0], /^COPY patches patches$/m);
  });
}
function installerRequire() {
  const makerRequire = createRequire(require.resolve("@electron-forge/maker-rpm"));
  return createRequire(makerRequire.resolve("electron-installer-redhat"));
}

for (const makerName of ["deb", "rpm"]) {
  test(`Linux ${makerName} owns both desktop and CLI links`, { skip: process.platform !== "linux" }, async () => {
    const { ElectronInstaller } = installerRequire()("electron-installer-common");
    const options = config.makers.find(maker => maker.name === `@electron-forge/maker-${makerName}`).config.options;
    assert.equal(options.bin, "mdbase-connect");
    assert.deepEqual(options.additionalBinaries, { mdbase: "resources/mdbase" });
    const root = await mkdtemp(join(tmpdir(), "mdbase-linux-package-"));
    try {
      const src = join(root, "app");
      await mkdir(join(src, "resources"), { recursive: true });
      await writeFile(join(src, "mdbase-connect"), "desktop");
      await writeFile(join(src, "resources/mdbase"), "cli");
      const installer = new ElectronInstaller({});
      installer.options = { ...options, src };
      installer.stagingDir = join(root, "stage");
      await installer.createBinarySymlink();
      assert.equal(await readlink(join(root, "stage/usr/bin/mdbase")), "../lib/mdbase-connect/resources/mdbase");
      assert.equal(await readlink(join(root, "stage/usr/bin/mdbase-connect")), "../lib/mdbase-connect/mdbase-connect");
      await rm(installer.stagingDir, { recursive: true });
      await rm(join(src, "resources/mdbase"));
      await assert.rejects(installer.createBinarySymlink(), /could not find/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("RPM manifest includes the CLI, while unconfigured consumers remain unchanged", { skip: process.platform !== "linux" }, async () => {
  const rpmRequire = installerRequire();
  const { template } = rpmRequire("lodash");
  const specPath = rpmRequire.resolve("../resources/spec.ejs");
  const render = template(await readFile(specPath, "utf8"));
  const options = {
    compressionLevel: 2, name: "mdbase-connect", version: "1.0.0", revision: "1",
    description: "test", license: "MIT", homepage: "", requires: [],
    productDescription: "test", icon: "test.png", pre: null, preun: null, post: null, postun: null
  };
  const spec = render({ ...options, additionalBinaries: { mdbase: "resources/mdbase" } });
  assert.match(spec, /%files\n\/usr\/bin\/mdbase-connect\n\/usr\/bin\/mdbase\n/);
  assert.doesNotMatch(render(options), /\/usr\/bin\/mdbase\n/);
});
