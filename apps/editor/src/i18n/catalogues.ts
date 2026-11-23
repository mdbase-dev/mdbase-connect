import english from "./locales/en/messages.json";

// Enumerated, deployment-local chunks, never a remote translation service.
const loaders = {
  fr: () => import("./locales/fr/messages.json"),
  de: () => import("./locales/de/messages.json"),
  es: () => import("./locales/es/messages.json"),
  ja: () => import("./locales/ja/messages.json"),
  ko: () => import("./locales/ko/messages.json"),
  pt: () => import("./locales/pt/messages.json"),
  ru: () => import("./locales/ru/messages.json"),
  zh: () => import("./locales/zh/messages.json"),
  it: () => import("./locales/it/messages.json")
};

export const editorCatalogues = {
  english,
  loadLocale: async (locale: keyof typeof loaders) => (await loaders[locale]()).default,
};
