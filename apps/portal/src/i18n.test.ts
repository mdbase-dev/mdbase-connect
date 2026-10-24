import { describe, expect, it } from "vitest";
import { appCatalogues, runtime } from "./i18n";

describe("portal catalogue integration", () => {
  it("starts synchronously in English with app and library messages", () => {
    expect(runtime.i18n.locale).toBe("en");
    expect(Object.keys(appCatalogues.english.messages).length).toBeGreaterThan(700);
    expect(Object.keys(runtime.i18n.messages).length).toBeGreaterThan(Object.keys(appCatalogues.english.messages).length);
    expect(document.documentElement.lang).toBe("en");
    // Keep shared app IDs: composition must validate, not mask, their translations.
    expect(Object.hasOwn(appCatalogues.english.messages, "dEgA5A")).toBe(true);
    expect(runtime.i18n._("dEgA5A")).toBe("Cancel");
  });
  it("loads target app catalogue chunks without activating them", async () => {
    for (const locale of ["fr", "de", "es", "ja", "ko", "pt", "ru", "zh", "it"] as const) {
      const catalogue = await appCatalogues.loadLocale(locale);
      expect(Object.keys(catalogue.messages).sort()).toEqual(Object.keys(appCatalogues.english.messages).sort());
    }
    expect(runtime.i18n.locale).toBe("en");
  });
  it("activates every authored app/library composition without filtering shared IDs", async () => {
    try {
      for (const locale of ["fr", "de", "es", "ja", "ko", "pt", "ru", "zh", "it"] as const) {
        await runtime.selectLocale(locale);
        expect(runtime.i18n.locale).toBe(locale);
        expect(document.documentElement.lang).toBe(locale);
      }
    } finally {
      await runtime.selectLocale("en");
    }
  });
});
