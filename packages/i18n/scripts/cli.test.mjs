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
  const run = (command, ...args) => process.platform === "win32"
    ? spawnSync(process.execPath, [bin, command, ...args], { cwd: root, encoding: "utf8" })
    : spawnSync(bin, [command, ...args], { cwd: root, encoding: "utf8" });
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
  // Published library JSON paths, not a second extraction scope or JS loader.
  const library = "vendor/ui/{locale}/messages.json";
  const secondLibrary = "vendor/other-ui/{locale}/messages.json";
  for (const locale of locales) {
    const catalogue = await readFile(resolve(root, `src/i18n/locales/${locale}/messages.json`), "utf8");
    for (const pattern of [library, secondLibrary]) {
      const filename = resolve(root, pattern.replace("{locale}", locale));
      await mkdir(resolve(filename, ".."), { recursive: true });
      await writeFile(filename, catalogue);
    }
  }
  const composed = run("check", "--compose", library, secondLibrary, "--config", "lingui.config.mjs");
  assert.equal(composed.status, 0, composed.stdout + composed.stderr);
  const id = Object.keys(french.messages)[0];
  for (const locale of ["fr", "de"]) {
    for (const [index, pattern] of [library, secondLibrary].entries()) {
      const filename = resolve(root, pattern.replace("{locale}", locale));
      const catalogue = JSON.parse(await readFile(filename, "utf8"));
      catalogue.messages[id] = [locale === "fr" ? "Salut" : "Guten Tag"];
      catalogue.messages["library-only"] = [index === 0 ? "Shared A" : "Shared B"];
      await writeFile(filename, JSON.stringify(catalogue));
    }
  }
  const collision = run("check", "--compose", library, "--compose", secondLibrary);
  assert.equal(collision.status, 1, collision.stdout + collision.stderr);
  for (const [locale, appValue, libraryValue] of [["fr", "Bonjour", "Salut"], ["de", "Hallo", "Guten Tag"]]) {
    assert.ok(collision.stderr.includes(`${locale}: Conflicting compiled translation for message ID: ${id} — ["${appValue}"] vs ["${libraryValue}"]`), collision.stderr);
    assert.ok(collision.stderr.includes(`${locale}: Conflicting compiled translation for message ID: library-only — ["Shared A"] vs ["Shared B"]`), collision.stderr);
  }
  const missingCompose = run("check", "--compose");
  assert.equal(missingCompose.status, 1);
  assert.match(missingCompose.stderr, /--compose requires/);
  const missingLocale = run("check", "--compose", "vendor/ui/fr/messages.json");
  assert.equal(missingLocale.status, 1);
  assert.match(missingLocale.stderr, /containing \{locale\}/);
  const missingLibrary = run("check", "--compose", "missing/{locale}/messages.json");
  assert.equal(missingLibrary.status, 1);
  assert.match(missingLibrary.stderr, /ENOENT/);
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
  await writeFile(resolve(root, "src/Unsafe.tsx"), 'export function Unsafe() { const [notice, setNotice] = useState(null); setNotice(`Account unlocked. ${count} private collections still need key access.`); return <p>{notice}</p>; }');
  const unsafeNotice = run("source");
  assert.equal(unsafeNotice.status, 1, unsafeNotice.stdout + unsafeNotice.stderr);
  assert.match(unsafeNotice.stderr, /unmarked visible interpolation.*Account unlocked/);
  const writerNotice = 'export function Workspace() { const [notice, setNotice] = useState(null); setNotice({ tone: "busy", text: COPY }); return notice && <div className={notice.tone}><span>{notice.text}</span></div>; }';
  await writeFile(resolve(root, "src/Unsafe.tsx"), writerNotice.replace("COPY", 't`Storing…`'));
  const safeObjectNotice = run("source");
  assert.equal(safeObjectNotice.status, 0, safeObjectNotice.stdout + safeObjectNotice.stderr);
  await writeFile(resolve(root, "src/Unsafe.tsx"), writerNotice.replace("COPY", '"Storing…"'));
  const unsafeObjectNotice = run("source");
  assert.equal(unsafeObjectNotice.status, 1, unsafeObjectNotice.stdout + unsafeObjectNotice.stderr);
  assert.match(unsafeObjectNotice.stderr, /unmarked visible string: Storing…/);
  assert.doesNotMatch(unsafeObjectNotice.stderr, /unmarked visible string: busy/);
  await writeFile(resolve(root, "src/Unsafe.tsx"), 'import { t } from "@lingui/core/macro"; export const extra = () => t\x60New message\x60;');
  const stale = run("check");
  assert.notEqual(stale.status, 0, "source extraction drift must fail");
  await rm(resolve(root, "src/Unsafe.tsx"));
  await writeFile(resolve(root, "src/App.tsx"), 'import { t, plural } from "@lingui/core/macro"; import { i18n } from "@lingui/core"; export function App({count}) { return <button>{t(i18n)\x60Hide ${plural(count, {one: "# file", other: "# files"})}\x60}</button>; }');
  const nestedExtracted = run("extract");
  assert.equal(nestedExtracted.status, 0, nestedExtracted.stdout + nestedExtracted.stderr);
  const nestedEnglish = await formatter({}).parse(await readFile(resolve(root, "src/i18n/locales/en/messages.po"), "utf8"), { locale: "en" });
  const active = Object.values(nestedEnglish).filter((entry) => !entry.obsolete);
  assert.equal(active.length, 1, "nested plural is one ICU descriptor, not nested translations");
  assert.match(active[0].message, /^Hide \{count, plural, one \{# file\} other \{# files\}\}$/);
  const nestedCompiled = run("compile");
  assert.equal(nestedCompiled.status, 0, nestedCompiled.stdout + nestedCompiled.stderr);
  const nestedSource = run("source");
  assert.equal(nestedSource.status, 0, nestedSource.stdout + nestedSource.stderr);
});
