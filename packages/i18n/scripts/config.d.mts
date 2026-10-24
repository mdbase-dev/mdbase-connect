import type { LinguiConfig } from "@lingui/conf";
export declare const locales: readonly ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh", "it"];
export declare function i18nConfig(options?: Omit<LinguiConfig,
  "locales" | "sourceLocale" | "fallbackLocales" | "format" | "catalogs" | "compileNamespace"> & {
    include?: string[]; exclude?: string[]; path?: string;
  }): LinguiConfig;
