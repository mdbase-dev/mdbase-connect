import { i18n } from "@lingui/core";
import { createI18nRuntime, type Catalogue, type RuntimeOptions } from "@mdbase-dev/i18n";
import editorEnglish from "./locales/en/messages.json";
import sharedEnglish from "./shared/en.json";

export const localeStorageKey = "mdbase-editor:locale";
const english = { messages: { ...sharedEnglish.messages, ...editorEnglish.messages } };

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
const sharedLoaders = import.meta.glob<Catalogue>("./shared/{fr,de,es,ja,ko,pt,ru,zh}.json", { import: "default" });

export function createEditorLocaleRuntime(options: Partial<RuntimeOptions> = {}) {
  return createI18nRuntime({
    english,
    loadLocale: async (locale) => {
      const [editor, shared] = await Promise.all([loaders[locale](), sharedLoaders[`./shared/${locale}.json`]!()]);
      return { messages: { ...shared.messages, ...editor.default.messages } };
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

// Shared controls and non-React core macros use this same instance.
export const editorLocaleRuntime = createEditorLocaleRuntime({ i18n });
