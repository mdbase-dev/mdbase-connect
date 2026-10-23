import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeLocale } from "../dist/main/i18n.js";

test("desktop locale restores a saved target language ahead of OS preferences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-desktop-language-"));
  try {
    const original = createNativeLocale(directory, ["en-US"]);
    await original.initialize();
    await original.selectLocale("de");
    assert.equal(original.i18n.locale, "de");
    assert.equal(original.i18n.number(1234.5), "1.234,5");
    assert.equal(await readFile(join(directory, "language"), "utf8"), "de");

    const restarted = createNativeLocale(directory, ["ja-JP"]);
    await restarted.initialize();
    assert.equal(restarted.i18n.locale, "de");
    await restarted.selectLocale("ja");
    assert.equal(restarted.i18n.locale, "ja");
    assert.equal(restarted.i18n.number(1234.5), "1,234.5");
    assert.equal(await readFile(join(directory, "language"), "utf8"), "ja");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("desktop composes every authored locale with both UI libraries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mdbase-desktop-composition-"));
  try {
    const runtime = createNativeLocale(directory, ["en-US"]);
    for (const locale of ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh"]) {
      await runtime.selectLocale(locale);
      assert.equal(runtime.i18n.locale, locale);
      assert.equal(await readFile(join(directory, "language"), "utf8"), locale);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
