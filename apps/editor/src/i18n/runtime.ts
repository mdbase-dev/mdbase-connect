import { i18n } from "@lingui/core";
import { createI18nRuntime, type RuntimeOptions } from "@mdbase-dev/i18n";
import { uiCatalogues } from "@mdbase-dev/ui/i18n";
import { connectUiCatalogues } from "@mdbase/connect-ui/i18n";
import english from "./locales/en/messages.json";

export const localeStorageKey = "mdbase-editor:locale";

// Enumerated, deployment-local chunks, never a remote translation service.
const loaders = {
  fr: () => import("./locales/fr/messages.json"),
  de: () => import("./locales/de/messages.json"),
  es: () => import("./locales/es/messages.json"),
  ja: () => import("./locales/ja/messages.json"),
  ko: () => import("./locales/ko/messages.json"),
  pt: () => import("./locales/pt/messages.json"),
  ru: () => import("./locales/ru/messages.json"),
  zh: () => import("./locales/zh/messages.json")
};

export function createEditorLocaleRuntime(options: Partial<RuntimeOptions> = {}) {
  return createI18nRuntime({
    english,
    libraries: [uiCatalogues, connectUiCatalogues],
    loadLocale: async (locale) => (await loaders[locale]()).default,
    storage: {
      getLocale: () => {
        // Browsers can deny storage access. Negotiation still works in that case.
        try { return localStorage.getItem(localeStorageKey); } catch { return null; }
      },
      setLocale: (locale) => localStorage.setItem(localeStorageKey, locale)
    },
    ...options
  });
}

// Shared controls and non-React core macros use this same instance.
export const editorLocaleRuntime = createEditorLocaleRuntime({ i18n });
