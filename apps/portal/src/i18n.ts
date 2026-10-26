import { createI18nRuntime } from "@mdbase-dev/i18n";
import { i18n, uiCatalogues } from "@mdbase-dev/ui/i18n";
import { connectUiCatalogues } from "@mdbase/connect-ui/i18n";
import english from "./locales/en/messages.json";
const loaders = {
  fr: () => import("./locales/fr/messages.json"),
  de: () => import("./locales/de/messages.json"),
  es: () => import("./locales/es/messages.json"),
  ja: () => import("./locales/ja/messages.json"),
  ko: () => import("./locales/ko/messages.json"),
  pt: () => import("./locales/pt/messages.json"),
  ru: () => import("./locales/ru/messages.json"),
  zh: () => import("./locales/zh/messages.json"),
};
export const appCatalogues = {
  english,
  loadLocale: async (locale: Exclude<import("@mdbase-dev/i18n").Locale, "en">) => (await loaders[locale]()).default,
};
export const runtime = createI18nRuntime({
  ...appCatalogues, i18n, libraries: [uiCatalogues, connectUiCatalogues],
  storage: {
    getLocale: () => localStorage.getItem("mdbase:portal:locale"),
    setLocale: (locale) => localStorage.setItem("mdbase:portal:locale", locale),
  },
});
