import { readFile } from "node:fs/promises";
import { formatter } from "@lingui/format-po";
import { describe, expect, it } from "vitest";
import { i18n, uiCatalogues } from "./i18n.js";

describe("library catalogue source", () => {
  it("has synchronous English and loads each deployment-local catalogue", async () => {
    for (const locale of ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh", "it"] as const) {
      const entries = await formatter({}).parse(await readFile(new URL(`./locales/${locale}/messages.po`, import.meta.url), "utf8"), { locale });
      const active = Object.entries(entries).filter(([, entry]) => !entry.obsolete).map(([id]) => id).sort();
      expect(active.length).toBeGreaterThan(100);
      const catalogue = locale === "en" ? uiCatalogues.english : await uiCatalogues.loadLocale(locale);
      expect(Object.keys(catalogue.messages).sort()).toEqual(active);
      expect(Object.keys(catalogue.messages).sort()).toEqual(Object.keys(uiCatalogues.english.messages).sort());
      expect(catalogue.messages).not.toHaveProperty("nzHlj8");
    }
  });
  it("does not activate a locale when a library chunk is loaded", async () => {
    const before = i18n.locale;
    await uiCatalogues.loadLocale("ja");
    expect(i18n.locale).toBe(before);
  });
});
