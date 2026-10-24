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
export const uiCatalogues: CatalogueSource = {
  english,
  loadLocale: async (locale) => (await loaders[locale]()).default,
};

import { i18n, type Messages } from "@lingui/core";
import { useSyncExternalStore } from "react";
export { i18n };

// Existing consumers without a language setting still receive synchronous English.
// Apps adopting the shared runtime load their own complete catalogues into this instance.
if (!i18n.locale) {
  i18n.load("en", english.messages as unknown as Messages);
  i18n.activate("en");
}
let revision = 0;
i18n.on("change", () => { revision += 1; });
const subscribe = (notify: () => void) => i18n.on("change", notify);
const snapshot = () => revision;

/** Presentation helpers use Lingui's singleton; changing language never remounts a form. */
export function useLocaleRevision(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
