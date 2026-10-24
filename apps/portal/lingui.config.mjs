import { i18nConfig } from "@mdbase-dev/i18n/config";
export default i18nConfig({
  include: ["<rootDir>/src"],
  exclude: ["**/*.test.*", "**/test/**", "**/*.d.ts"],
  path: "<rootDir>/src/locales/{locale}/messages",
});
