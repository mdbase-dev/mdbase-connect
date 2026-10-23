#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { getConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";
import { assertCompleteCatalogue } from "./checks.mjs";
import { inspectUiSource } from "./source.mjs";
import { locales } from "./config.mjs";

const require = createRequire(import.meta.url);
const lingui = resolve(dirname(require.resolve("@lingui/cli")), "lingui.js");
function run(args) {
  const result = spawnSync(process.execPath, [lingui, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Lingui " + args.join(" ") + " failed");
}
export async function main(command, args = []) {
  if (!["extract", "compile", "check", "source"].includes(command))
    throw new Error("Usage: mdbase-i18n extract|compile|check|source [--config lingui.config.ts]");
  if (command === "extract") return run(["extract", "--workers", "1", ...args]);
  if (command === "compile") return run(["compile", "--strict", "--workers", "1", ...args]);
  const configIndex = args.indexOf("--config");
  const config = getConfig({ configPath: configIndex < 0 ? undefined : args[configIndex + 1] });
  let policy = {};
  try { policy = JSON.parse(await readFile(resolve(config.rootDir, "i18n-policy.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (command === "check") {
    if (JSON.stringify(config.locales) !== JSON.stringify(locales) || config.sourceLocale !== "en" || config.compileNamespace !== "json")
      throw new Error("Use the nine-locale English-source strict-JSON kit preset");
    run(["check", "sync", ...args]);
    for (const catalogue of config.catalogs) {
      const load = async (locale) => formatter({}).parse(
        await readFile(catalogue.path.replaceAll("{locale}", locale) + ".po", "utf8"), { locale });
      const english = await load("en");
      for (const locale of locales)
        assertCompleteCatalogue(english, await load(locale), locale, policy.allowIdentical?.[locale]);
    }
    run(["compile", "--strict", "--workers", "1", ...args]);
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
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main(process.argv[2], process.argv.slice(3)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
