import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { getConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { assertCompleteCatalogue } from "./checks.mjs";
import { inspectUiSource } from "./source.mjs";
import { locales } from "./config.mjs";
// Shared with the runtime, but executable before the workspace has any dist.
import { mergeCatalogues } from "./catalogues.mjs";

const require = createRequire(import.meta.url);
const lingui = resolve(dirname(require.resolve("@lingui/cli")), "lingui.js");
function run(args) {
  const result = spawnSync(process.execPath, [lingui, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Lingui " + args.join(" ") + " failed");
}
// Lingui 6.9 compiles obsolete PO entries, including English fallback values.
// Prune at the shared compile boundary, not as a one-off catalogue cleanup.
async function compile(config, args) {
  for (const catalogue of config.catalogs) {
    for (const locale of config.locales) {
      const filename = catalogue.path.replaceAll("{locale}", locale) + ".po";
      const existing = await readFile(filename, "utf8");
      const context = { locale, sourceLocale: config.sourceLocale, filename, existing };
      const entries = await config.format.parse(existing, context);
      const active = Object.entries(entries).filter(([, entry]) => !entry.obsolete);
      if (active.length !== Object.keys(entries).length)
        await writeFile(filename, await config.format.serialize(Object.fromEntries(active), context));
    }
  }
  run(["compile", "--strict", "--workers", "1", ...args]);
}
export async function main(command, args = []) {
  if (!["extract", "compile", "check", "source"].includes(command))
    throw new Error("Usage: mdbase-i18n extract|compile|check|source [--config lingui.config.ts] [--compose library/{locale}/messages.json ...]");
  const compose = [];
  const linguiArgs = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--compose") { linguiArgs.push(args[index]); continue; }
    if (command !== "check") throw new Error("--compose is only supported by check");
    const start = compose.length;
    while (index + 1 < args.length && !args[index + 1].startsWith("--")) compose.push(args[++index]);
    if (compose.length === start) throw new Error("--compose requires compiled JSON paths containing {locale}");
  }
  if (compose.some((path) => !path.includes("{locale}") || !path.endsWith(".json")))
    throw new Error("--compose requires compiled JSON paths containing {locale}");
  args = linguiArgs;
  if (command === "extract") return run(["extract", "--workers", "1", ...args]);
  const configIndex = args.indexOf("--config");
  const config = getConfig({ configPath: configIndex < 0 ? undefined : args[configIndex + 1] });
  if (command === "compile") return compile(config, args);
  let policy = {};
  try { policy = JSON.parse(await readFile(resolve(config.rootDir, "i18n-policy.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (command === "check") {
    if (JSON.stringify(config.locales) !== JSON.stringify(locales) || config.sourceLocale !== "en" || config.compileNamespace !== "json")
      throw new Error("Use the ten-locale English-source strict-JSON kit preset");
    run(["check", "sync", ...args]);
    for (const catalogue of config.catalogs) {
      const load = async (locale) => formatter({}).parse(
        await readFile(catalogue.path.replaceAll("{locale}", locale) + ".po", "utf8"), { locale });
      const english = await load("en");
      for (const locale of locales)
        assertCompleteCatalogue(english, await load(locale), locale, policy.allowIdentical?.[locale]);
    }
    await compile(config, args);
    // Use exactly the runtime's compiled-value equality, including nested ICU objects.
    // Include every app scope so app/app and library/library collisions also fail.
    const paths = [...config.catalogs.map((catalogue) => catalogue.path + ".json"),
      ...compose.map((path) => resolve(config.rootDir, path))];
    const conflicts = [];
    for (const locale of locales) {
      const catalogues = await Promise.all(paths.map(async (path) => {
        const filename = path.replaceAll("{locale}", locale);
        const catalogue = JSON.parse(await readFile(filename, "utf8"));
        if (!catalogue.messages || typeof catalogue.messages !== "object" || Array.isArray(catalogue.messages))
          throw new Error("Expected compiled catalogue messages: " + filename);
        return catalogue;
      }));
      try { mergeCatalogues(catalogues); }
      catch (error) { conflicts.push(...error.message.split("\n").map((line) => locale + ": " + line)); }
    }
    if (conflicts.length) throw new Error(conflicts.join("\n"));
  }
  const source = policy.source ?? {};
  const includes = source.include ?? config.catalogs.flatMap((catalogue) => catalogue.include);
  const excludes = [...new Set(["**/node_modules/**", "**/locales/**", "**/*.test.*", "**/*.spec.*",
    ...config.catalogs.flatMap((catalogue) => catalogue.exclude ?? []), ...(source.exclude ?? [])])];
  const files = [];
  // Source includes are directories; excludes are Node's platform-independent glob patterns.
  const { matchesGlob } = await import("node:path");
  async function walk(path) {
    const relative = path.slice(config.rootDir.length + 1).replaceAll("\\", "/");
    if (excludes.some((pattern) => matchesGlob(relative, pattern))) return;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !excludes.some((pattern) => matchesGlob(child.slice(config.rootDir.length + 1), pattern))) files.push(child);
    }
  }
  for (const include of new Set(includes)) await walk(resolve(config.rootDir, include.replace("<rootDir>/", "")));
  const issues = (await Promise.all(files.map(async (file) => inspectUiSource(await readFile(file, "utf8"), file, source)))).flat();
  if (issues.length) throw new Error(issues.map((i) => i.file + ":" + i.line + " " + i.kind + ": " + i.text).join("\n"));
  console.log("i18n: catalogue contracts and source guard passed (" + files.length + " modules).");
}
