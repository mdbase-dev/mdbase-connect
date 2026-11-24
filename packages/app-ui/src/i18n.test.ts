import { readFile } from "node:fs/promises";
import { formatter } from "@lingui/format-po";
import { describe, expect, it } from "vitest";
import { i18n, uiCatalogues } from "./i18n.js";

describe("library catalogue source", () => {
  it("has synchronous English and loads each deployment-local catalogue", async () => {
    for (const locale of ["en", "fr", "de", "es", "ja", "ko", "pt", "ru", "zh", "it"] as const) {
      const entries = await formatter({}).parse(await readFile(new URL(`./locales/${locale}/messages.po`, import.meta.url), "utf8"), { locale, sourceLocale: "en", filename: `locales/${locale}/messages.po` });
      const active = Object.entries(entries).filter(([, entry]) => !entry.obsolete).map(([id]) => id).sort();
      expect(active.length).toBeGreaterThan(100);
      const catalogue = locale === "en" ? uiCatalogues.english : await uiCatalogues.loadLocale(locale);
      expect(Object.keys(catalogue.messages).sort()).toEqual(active);
      expect(Object.keys(catalogue.messages).sort()).toEqual(Object.keys(uiCatalogues.english.messages).sort());
      expect(catalogue.messages).not.toHaveProperty("nzHlj8");
    }
  });
  it("gives every new message a context, so its id cannot match an app's own message", async () => {
    // Apps compose this catalogue with their own, and a context-less id is just a hash of the English text:
    // a shared "Clear" would take over an app's "Clear" and its translations. Only the frozen legacy ids may omit one.
    const { withoutContext } = JSON.parse(await readFile(new URL("../i18n-context-baseline.json", import.meta.url), "utf8")) as { withoutContext: string[] };
    const entries = await formatter({}).parse(await readFile(new URL("./locales/en/messages.po", import.meta.url), "utf8"), { locale: "en", sourceLocale: "en", filename: "locales/en/messages.po" });
    const missing = Object.entries(entries).filter(([id, entry]) => !entry.obsolete && !entry.context && !withoutContext.includes(id));
    expect(missing.map(([id, entry]) => `${id} ${entry.message}`)).toEqual([]);
  });
  it("does not activate a locale when a library chunk is loaded", async () => {
    const before = i18n.locale;
    await uiCatalogues.loadLocale("ja");
    expect(i18n.locale).toBe(before);
  });
});
