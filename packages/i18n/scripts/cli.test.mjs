import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { formatter } from "@lingui/format-po";
import { locales } from "./config.mjs";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
test("packed npm .bin CLI runs extraction, catalogue checks, compile and source guard", async (t) => {
  // Spaces also ensure the entry point does not compare a path with an encoded URL.
  const root = await mkdtemp(resolve(tmpdir(), "mdbase i18n packed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", root], { cwd: packageRoot, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const installed = resolve(root, "node_modules/@mdbase-dev/i18n");
  await mkdir(installed, { recursive: true });
  const unpacked = spawnSync("tar", ["-xzf", resolve(root, `mdbase-dev-i18n-${manifest.version}.tgz`), "--strip-components=1", "-C", installed], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stdout + unpacked.stderr);
  // Reuse installed dependencies offline, but load every kit file from the tarball.
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    const destination = resolve(root, "node_modules", name);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await symlink(resolve(packageRoot, "node_modules", name), destination, "junction");
  }
  const bin = resolve(root, "node_modules/.bin/mdbase-i18n");
  await mkdir(resolve(bin, ".."));
  await symlink(resolve(installed, manifest.bin["mdbase-i18n"]), bin, "file");
  await mkdir(resolve(root, "src"));
  await writeFile(resolve(root, "package.json"), '{"type":"module"}');
  await writeFile(resolve(root, "lingui.config.mjs"), 'import { i18nConfig } from "@mdbase-dev/i18n/config"; export default i18nConfig();');
  await writeFile(resolve(root, "src/App.tsx"), 'import { t } from "@lingui/core/macro"; export function App() { return <button aria-label={t\x60Hello\x60}>{t\x60Hello\x60}</button>; }');
  const run = (command) => process.platform === "win32"
    ? spawnSync(process.execPath, [bin, command], { cwd: root, encoding: "utf8" })
    : spawnSync(bin, [command], { cwd: root, encoding: "utf8" });
  const invalid = run("not-a-command");
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.match(invalid.stderr, /Usage: mdbase-i18n/);
  const extracted = run("extract");
  assert.equal(extracted.status, 0, extracted.stdout + extracted.stderr);
  const translations = { en: "Hello", fr: "Bonjour", de: "Hallo", es: "Hola", ja: "こんにちは", ko: "안녕하세요", pt: "Olá", ru: "Здравствуйте", zh: "你好" };
  for (const locale of locales) {
    const filename = resolve(root, "src/i18n/locales", locale, "messages.po");
    const existing = await readFile(filename, "utf8");
    const context = { locale, sourceLocale: "en", filename, existing };
    const entries = await formatter({}).parse(existing, context);
    for (const entry of Object.values(entries)) entry.translation = translations[locale];
    await writeFile(filename, await formatter({ origins: true, lineNumbers: false }).serialize(entries, context));
  }
  const checked = run("check");
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /i18n: catalogue contracts and source guard passed \(1 modules\)/);
  const french = JSON.parse(await readFile(resolve(root, "src/i18n/locales/fr/messages.json"), "utf8"));
  assert.equal(Object.values(french.messages)[0][0], "Bonjour");
  const frenchPath = resolve(root, "src/i18n/locales/fr/messages.po");
  const validFrench = await readFile(frenchPath, "utf8");
  await writeFile(frenchPath, validFrench.replace('msgstr "Bonjour"', 'msgstr ""'));
  const broken = run("check");
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.stderr, /fr missing authored translation before fallback/);
  await writeFile(frenchPath, validFrench);
  const compiled = run("compile");
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const source = run("source");
  assert.equal(source.status, 0, source.stdout + source.stderr);
  assert.match(source.stdout, /source guard passed \(1 modules\)/);
  await writeFile(resolve(root, "src/Unsafe.tsx"), "export function Unsafe() { return <p>Unmarked copy</p>; }");
  const unsafe = run("check");
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /unmarked JSX/);
  await writeFile(resolve(root, "src/Unsafe.tsx"), 'import { t } from "@lingui/core/macro"; export const extra = () => t\x60New message\x60;');
  const stale = run("check");
  assert.notEqual(stale.status, 0, "source extraction drift must fail");
});
