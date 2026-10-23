import { mergeCatalogues, type Catalogue } from "@mdbase-dev/i18n";
import { uiCatalogues } from "@mdbase-dev/ui/i18n";
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
// A shared message ID has one owner: the library, even while app POs are
// untranslated. First validate English collisions; never hide different source copy.
const libraries = [uiCatalogues, connectUiCatalogues];
mergeCatalogues([english, ...libraries.map((source) => source.english)]);
const sharedIds = new Set(libraries.flatMap((source) => Object.keys(source.english.messages)));
function appOnly(catalogue: Catalogue): Catalogue {
  return { ...catalogue, messages: Object.fromEntries(
    Object.entries(catalogue.messages).filter(([id]) => !sharedIds.has(id)),
  ) };
}
export const appCatalogues = {
  english: appOnly(english),
  loadLocale: async (locale: Exclude<import("@mdbase-dev/i18n").Locale, "en">) => appOnly((await loaders[locale]()).default),
};
