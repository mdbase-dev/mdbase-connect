import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  locales: ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh"],
  sourceLocale: "en",
  fallbackLocales: { default: "en" },
  format: formatter({ origins: true, lineNumbers: false }),
  catalogs: [{
    path: "<rootDir>/src/i18n/locales/{locale}/messages",
    include: ["<rootDir>/src/settings", "<rootDir>/src/i18n"],
    exclude: ["**/*.test.*", "**/test/**", "**/demo-*", "**/test-setup.ts"]
  }],
  compileNamespace: "json"
});
