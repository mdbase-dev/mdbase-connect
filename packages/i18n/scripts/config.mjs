import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

export const locales = ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh"];
/** Source/context generated IDs are Lingui's default; never supply explicit IDs. */
export function i18nConfig({ include = ["<rootDir>/src"], exclude = ["**/*.test.*", "**/*.spec.*"],
  path = "<rootDir>/src/i18n/locales/{locale}/messages", ...options } = {}) {
  return defineConfig({
    ...options, locales, sourceLocale: "en", fallbackLocales: { default: "en" },
    format: formatter({ origins: true, lineNumbers: false }),
    catalogs: [{ path, include, exclude }], compileNamespace: "json",
  });
}
