// Minimal Electron-shaped bundles exercise the real Forge makers without a GUI build.
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { MakerDeb } = require("@electron-forge/maker-deb");
const { MakerRpm } = require("@electron-forge/maker-rpm");
const forge = require("../forge.config.cjs");

async function main() {
  for (const version of ["0.0.1", "0.0.2"]) {
    const dir = join("/tmp", `mdbase-package-fixture-${version}`);
    await mkdir(join(dir, "resources/app"), { recursive: true });
    await writeFile(join(dir, "resources/app/package.json"), JSON.stringify({
      name: "mdbase-connect", version, description: "Packaging lifecycle fixture",
      author: "mdbase", license: "MIT"
    }));
    await writeFile(join(dir, "LICENSE"), "MIT\n");
    await writeFile(join(dir, "version"), require("electron/package.json").version);
    await writeFile(join(dir, "mdbase-connect"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(dir, "resources/mdbase"), `#!/bin/sh\necho 'mdbase ${version}'\n`, { mode: 0o755 });
    for (const [name, Maker] of [["deb", MakerDeb], ["rpm", MakerRpm]]) {
      const options = { ...forge.makers.find(maker => maker.name === `@electron-forge/maker-${name}`).config.options };
      // Upgrade from the historical desktop-only package to the fixed package.
      if (version === "0.0.1") delete options.additionalBinaries;
      const maker = new Maker({ options });
      await maker.prepareConfig(process.arch);
      const artifacts = await maker.make({ dir, makeDir: `/output/${version}`, targetArch: process.arch });
      await writeFile(`/output/${version}/${name}.json`, JSON.stringify(artifacts));
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
