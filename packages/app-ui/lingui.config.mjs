import { i18nConfig } from "@mdbase-dev/i18n/config";
export default i18nConfig({
  include: ["<rootDir>/src"],
  exclude: ["**/*.test.*", "**/testing.ts", "**/dist/**", "**/node_modules/**", "**/scripts/**"],
  path: "<rootDir>/src/locales/{locale}/messages",
});
