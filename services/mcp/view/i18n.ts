import { createI18nRuntime, type Locale } from "@mdbase-dev/i18n";
import { i18n, uiCatalogues } from "@mdbase-dev/ui/i18n";
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

/** The view speaks the host's language; it has no setting of its own to remember. */
export function viewRuntime(hostLocale: string | undefined) {
  return createI18nRuntime({
    english,
    loadLocale: async (locale: Exclude<Locale, "en">) => (await loaders[locale]()).default,
    i18n,
    libraries: [uiCatalogues],
    preferences: hostLocale ? [hostLocale] : undefined,
  });
}
