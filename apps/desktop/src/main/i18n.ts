import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createI18nRuntime } from "@mdbase-dev/i18n";
import { i18n, uiCatalogues } from "@mdbase-dev/ui/i18n";
import { connectUiCatalogues } from "@mdbase/connect-ui/i18n";
import { appCatalogues } from "../catalogues";

export function createNativeLocale(directory: string, preferences: readonly string[]) {
  const path = join(directory, "language");
  return createI18nRuntime({
    ...appCatalogues, i18n, libraries: [uiCatalogues, connectUiCatalogues], preferences,
    storage: {
      async getLocale() {
        try { return (await readFile(path, "utf8")).trim(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      },
      async setLocale(locale) {
        await mkdir(directory, { recursive: true });
        await writeFile(path, locale, "utf8");
      },
    },
  });
}
