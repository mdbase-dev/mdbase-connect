import { i18nConfig } from "@mdbase-dev/i18n/config";

// Expand these directories as complete editor surfaces are migrated. Shared UI
// owns its catalogues; don't duplicate its messages in the editor catalogue.
export default i18nConfig({
  include: ["<rootDir>/src/settings", "<rootDir>/src/i18n"],
  exclude: ["**/*.test.*", "**/test/**"]
});
