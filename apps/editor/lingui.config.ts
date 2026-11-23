import { i18nConfig } from "@mdbase-dev/i18n/config";

// Shared UI owns separate catalogues, composed with this one by the runtime.
export default i18nConfig({
  include: ["<rootDir>/src", "<rootDir>/direct"],
  exclude: ["**/vite.config.ts", "**/*.test.*", "**/test/**", "**/*.generated.*", "**/demo-*.ts"]
});
