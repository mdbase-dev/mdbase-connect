import { i18nConfig } from "@mdbase-dev/i18n/config";
export default i18nConfig({
  include: ["<rootDir>/."],
  exclude: ["**/*.test.*", "**/testing.ts", "**/dist/**", "**/node_modules/**", "**/scripts/**"],
  path: "<rootDir>/locales/{locale}/messages",
});
