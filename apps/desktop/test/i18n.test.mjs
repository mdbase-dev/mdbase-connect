import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeLocale } from "../dist/main/i18n.js";

test("desktop locale saves an explicit choice and ignores unsupported saved languages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-desktop-language-"));
  try {
    await writeFile(join(directory, "language"), "unsupported");
    const runtime = createNativeLocale(directory, ["en-US"]);
    assert.equal(runtime.i18n.locale, "en");
    await runtime.initialize();
    assert.equal(runtime.i18n.locale, "en");
    await runtime.selectLocale("en");
    assert.equal(await readFile(join(directory, "language"), "utf8"), "en");
    await assert.rejects(runtime.selectLocale("unsupported"), /Unsupported locale/);
    assert.equal(runtime.i18n.locale, "en");
    assert.equal(await readFile(join(directory, "language"), "utf8"), "en");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
