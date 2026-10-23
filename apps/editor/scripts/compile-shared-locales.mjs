import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { formatter } from "@lingui/format-po";
import { createCompiledCatalog } from "@lingui/cli/api";

// Consume the shared packages' PO sources without writing into their checkouts.
// Their published runtime exports do not yet include compiled locale catalogues.
const root = new URL("../../../", import.meta.url);
const packages = ["packages/app-ui/", "packages/ui/"];
const localePath = ["src/locales/", "locales/"];
const englishOnly = process.argv.includes("--english-only");
const locales = englishOnly ? ["en"] : ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh"];
if (!englishOnly) {
  for (const directory of packages) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("packages/i18n/scripts/cli.mjs", root)), "check"], {
      cwd: fileURLToPath(new URL(directory, root)), stdio: "inherit"
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
const destination = new URL("../src/i18n/shared/", import.meta.url);
await mkdir(destination, { recursive: true });
for (const locale of locales) {
  const messages = {};
  for (const [index, directory] of packages.entries()) {
    const po = await readFile(new URL(`${directory}${localePath[index]}${locale}/messages.po`, root), "utf8");
    const catalogue = formatter({}).parse(po, { locale });
    for (const [id, entry] of Object.entries(catalogue)) {
      if (entry.obsolete) continue;
      const message = entry.translation || (locale === "en" ? entry.message : undefined);
      if (!message) throw new Error(`${directory}${locale}: missing authored translation ${id}`);
      if (messages[id] && messages[id] !== message) throw new Error(`Conflicting shared message ${id}`);
      messages[id] = message;
    }
  }
  const result = createCompiledCatalog(locale, messages, { namespace: "json", strict: true });
  if (result.errors.length) throw new Error(result.errors.map(({ id, error }) => `${locale}:${id}: ${error.message}`).join("\n"));
  await writeFile(new URL(`${locale}.json`, destination), result.source + "\n");
}
