import { describe, expect, it } from "vitest";
import { i18n, uiCatalogues } from "./i18n.js";

describe("library catalogue source", () => {
  it("has synchronous English and loads each deployment-local catalogue", async () => {
    expect(Object.keys(uiCatalogues.english.messages).length).toBeGreaterThan(100);
    for (const locale of ["fr", "de", "es", "ja", "ko", "pt", "ru", "zh"] as const) {
      const catalogue = await uiCatalogues.loadLocale(locale);
      expect(Object.keys(catalogue.messages).sort()).toEqual(Object.keys(uiCatalogues.english.messages).sort());
    }
  });
  it("does not activate a locale when a library chunk is loaded", async () => {
    const before = i18n.locale;
    await uiCatalogues.loadLocale("ja");
    expect(i18n.locale).toBe(before);
  });
});
