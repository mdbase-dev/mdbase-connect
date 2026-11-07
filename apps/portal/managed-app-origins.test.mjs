import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the Portal container build includes its canonical managed-environment config", async () => {
  const dockerfile = await readFile(new URL("../../deploy/docker/Dockerfile.server", import.meta.url), "utf8");
  assert.match(dockerfile, /^COPY scripts\/lib\/managed-environments\.mjs scripts\/lib\/managed-environments\.mjs$/mu);
});
