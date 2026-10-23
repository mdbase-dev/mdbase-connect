import { i18n } from "@lingui/core";
import { createI18nRuntime, type RuntimeOptions } from "@mdbase-dev/i18n";
import editorEnglish from "./locales/en/messages.json";
import uiEnglish from "../../../../packages/app-ui/src/locales/en/messages.json";
import connectEnglish from "../../../../packages/ui/locales/en/messages.json";

const english = { ...uiEnglish, ...connectEnglish, ...editorEnglish };
// Shared controls use the same Lingui instance, but retain separately authored PO files.
const sharedLoaders = import.meta.glob<Record<string, unknown>>(
  "../../../../packages/{app-ui/src,ui}/locales/{fr,de,es,ja,ko,pt,ru,zh}/messages.json",
  { import: "default" }
);

export const localeStorageKey = "mdbase-editor:locale";

// Enumerated imports are deployment-local chunks, never a remote translation service.
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
    loadLocale: async (locale) => {
      const shared = await Promise.all(Object.entries(sharedLoaders)
        .filter(([path]) => path.endsWith(`/${locale}/messages.json`))
        .map(([, load]) => load()));
      return Object.assign({}, ...shared, (await loaders[locale]()).default);
    },
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

export const editorLocaleRuntime = createEditorLocaleRuntime({ i18n });
