import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const require = createRequire(import.meta.url);

test("packaged macOS builds allow only local-network ATS exceptions for staging", () => {
  const config = require("../forge.config.cjs");
  assert.deepEqual(config.packagerConfig.extendInfo?.NSAppTransportSecurity, {
    NSAllowsLocalNetworking: true
  });
  assert.equal(
    config.packagerConfig.extendInfo?.NSAppTransportSecurity
      ?.NSAllowsArbitraryLoads,
    undefined
  );
});

test("Store packaging owns deep links and does not advertise registry login items", async () => {
  const manifest = await readFile(new URL("../assets/AppxManifest.xml", import.meta.url), "utf8");
  const configure = await readFile(new URL("../../../scripts/configure-windows-store-package.ps1", import.meta.url), "utf8");
  const verify = await readFile(new URL("../../../scripts/verify-windows-packages.ps1", import.meta.url), "utf8");
  const main = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
  assert.match(manifest, /Category="windows.protocol"/);
  assert.match(manifest, /Protocol Name="mdbase-connect"/);
  assert.match(manifest, /Executable="app\\mdbase-connect.exe"/);
  assert.match(configure, /\[xml\]\$manifest/);
  assert.match(configure, /WINDOWS_STORE_MANIFEST=\$manifestPath/);
  assert.match(verify, /Store package must register the mdbase-connect deep-link protocol/);
  assert.match(main, /if \(process.windowsStore \|\| !shouldRegisterDeepLinks\(\)\) return/);
  assert.equal((main.match(/!app.isPackaged \|\| process.windowsStore/g) ?? []).length, 2);
});

test(
  "Linux makers target the packaged executable",
  { skip: process.platform !== "linux" },
  () => {
    const config = require("../forge.config.cjs");
    const makers = new Map(config.makers.map((maker) => [maker.name, maker]));

    assert.equal(config.packagerConfig.executableName, "mdbase-connect");

    for (const name of [
      "@electron-forge/maker-deb",
      "@electron-forge/maker-rpm"
    ]) {
      const options = makers.get(name)?.config?.options;
      assert.equal(options?.name, "mdbase-connect");
      assert.equal(options?.bin, "mdbase-connect");
    }

    assert.equal(
      makers.get("@electron-forge/maker-rpm")?.config?.options?.license,
      "MIT"
    );
  }
);
