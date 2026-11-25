import { i18nConfig } from "@mdbase-dev/i18n/config";
export default i18nConfig({
  include: ["<rootDir>/view"],
  exclude: ["**/*.test.*", "**/*.d.ts"],
  path: "<rootDir>/view/locales/{locale}/messages",
});
