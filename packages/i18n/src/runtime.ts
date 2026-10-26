import { setupI18n, type I18n, type Messages } from "@lingui/core";
import { mergeCatalogues } from "../scripts/catalogues.mjs";
export { mergeCatalogues } from "../scripts/catalogues.mjs";

export const locales = ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh"] as const;
export type Locale = (typeof locales)[number];
export const localeNames: Record<Locale, string> = {
  en: "English", fr: "Français", de: "Deutsch", es: "Español",
  ja: "日本語", ko: "한국어", pt: "Português (Brasil)", ru: "Русский", zh: "简体中文",
};
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && locales.includes(value as Locale);
}
export function negotiateLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    const base = preference.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return "en";
}
export interface LocaleStorage {
  getLocale(): string | null | Promise<string | null>;
  setLocale(locale: Locale): void | Promise<void>;
}
/** JSON imports lose compiled tuple types. This is compiler-owned ICU data, not code. */
export interface Catalogue { messages: object }
export interface CatalogueSource {
  english: Catalogue;
  loadLocale: (locale: Exclude<Locale, "en">) => Promise<Catalogue>;
}
export interface RuntimeOptions extends CatalogueSource {
  /** Inject the Lingui global singleton when existing core macros target it. */
  i18n?: I18n;
  /** Libraries own their PO scope and lazy compiled catalogues, never a provider. */
  libraries?: readonly CatalogueSource[];
  storage?: LocaleStorage;
  preferences?: readonly string[];
  document?: Pick<Document, "documentElement">;
}
export function createI18nRuntime(options: RuntimeOptions) {
  const i18n = options.i18n ?? setupI18n();
  const sources: readonly CatalogueSource[] = [options, ...(options.libraries ?? [])];
  i18n.load("en", mergeCatalogues(sources.map((source) => source.english)).messages as Messages);
  i18n.activate("en");
  const document = options.document ?? (typeof globalThis.document === "undefined" ? undefined : globalThis.document);
  let generation = 0;
  let initialization: Promise<void> | undefined;
  let saving: Promise<void> = Promise.resolve();
  const loaded = new Set<Locale>(["en"]);
  const syncDocument = () => {
    if (document) {
      document.documentElement.lang = i18n.locale;
      document.documentElement.dir = "ltr"; // All nine supported languages use LTR scripts.
    }
  };
  syncDocument();
  async function activate(locale: Locale, persist: boolean) {
    const request = ++generation;
    if (!loaded.has(locale) && locale !== "en") {
      const catalogues = await Promise.all(sources.map((source) => source.loadLocale(locale)));
      if (request !== generation) return;
      const catalogue = mergeCatalogues(catalogues);
      i18n.load(locale, catalogue.messages as Messages);
      loaded.add(locale);
    }
    if (request !== generation) return;
    i18n.activate(locale);
    syncDocument();
    if (persist && options.storage) {
      // Serialize async adapters so an older slow write cannot replace a newer choice.
      const storage = options.storage;
      saving = saving.catch(() => undefined).then(async () => {
        if (request === generation) await storage.setLocale(locale);
      });
      await saving;
    }
  }
  return {
    i18n,
    /** Idempotent, and deliberately not awaited by the provider's first render. */
    initialize(): Promise<void> {
      initialization ??= (async () => {
        const request = generation;
        const stored = await options.storage?.getLocale();
        if (request !== generation) return; // A user choice wins over delayed startup.
        const preferences = options.preferences ??
          (typeof navigator === "undefined" ? [] : navigator.languages);
        await activate(isLocale(stored) ? stored : negotiateLocale(preferences), false);
      })();
      return initialization;
    },
    /** Load failures leave the active catalogue and stored choice untouched. */
    selectLocale(locale: Locale): Promise<void> {
      if (!isLocale(locale)) return Promise.reject(new Error("Unsupported locale"));
      return activate(locale, true);
    },
  };
}
export type I18nRuntime = ReturnType<typeof createI18nRuntime>;

/** Display-only formatting: never use these to serialize record values. */
export function formatters(locale: string) {
  const intlLocale = locale === "pt" ? "pt-BR" : locale === "zh" ? "zh-CN" : locale;
  return {
    date: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(intlLocale, options).format(value),
    number: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(intlLocale, options).format(value),
    relativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions) =>
      new Intl.RelativeTimeFormat(intlLocale, options).format(value, unit),
  };
}
