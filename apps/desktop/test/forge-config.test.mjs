import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
