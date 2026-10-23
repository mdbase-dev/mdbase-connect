import { describe, expect, it } from "vitest";
import { appCatalogues, runtime } from "./i18n";

describe("portal catalogue integration", () => {
  it("starts synchronously in English with app and library messages", () => {
    expect(runtime.i18n.locale).toBe("en");
    expect(Object.keys(appCatalogues.english.messages).length).toBeGreaterThan(700);
    expect(Object.keys(runtime.i18n.messages).length).toBeGreaterThan(Object.keys(appCatalogues.english.messages).length);
    expect(document.documentElement.lang).toBe("en");
    // Shared Cancel is library-owned rather than an app fallback/translation conflict.
    expect(Object.hasOwn(appCatalogues.english.messages, "dEgA5A")).toBe(false);
    expect(runtime.i18n._("dEgA5A")).toBe("Cancel");
  });
  it("loads target app catalogue chunks without activating them", async () => {
    for (const locale of ["fr", "de", "es", "ja", "ko", "pt", "ru", "zh"] as const) {
      const catalogue = await appCatalogues.loadLocale(locale);
      expect(Object.keys(catalogue.messages).sort()).toEqual(Object.keys(appCatalogues.english.messages).sort());
    }
    expect(runtime.i18n.locale).toBe("en");
  });
});
