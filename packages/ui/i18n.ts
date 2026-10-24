import type { CatalogueSource } from "@mdbase-dev/i18n";
import english from "./locales/en/messages.json" with { type: "json" };
const loaders = {
  fr: () => import("./locales/fr/messages.json", { with: { type: "json" } }),
  de: () => import("./locales/de/messages.json", { with: { type: "json" } }),
  es: () => import("./locales/es/messages.json", { with: { type: "json" } }),
  ja: () => import("./locales/ja/messages.json", { with: { type: "json" } }),
  ko: () => import("./locales/ko/messages.json", { with: { type: "json" } }),
  pt: () => import("./locales/pt/messages.json", { with: { type: "json" } }),
  ru: () => import("./locales/ru/messages.json", { with: { type: "json" } }),
  zh: () => import("./locales/zh/messages.json", { with: { type: "json" } }),
  it: () => import("./locales/it/messages.json", { with: { type: "json" } }),
};
export const connectUiCatalogues: CatalogueSource = {
  english,
  loadLocale: async (locale) => (await loaders[locale]()).default,
};
