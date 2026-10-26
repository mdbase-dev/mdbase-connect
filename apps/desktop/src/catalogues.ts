import type { Locale } from "@mdbase-dev/i18n";
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
  it: () => import("./locales/it/messages.json"),
};
export const appCatalogues = {
  english,
  loadLocale: async (locale: Exclude<Locale, "en">) => (await loaders[locale]()).default,
};
