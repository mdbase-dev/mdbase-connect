import { describe, expect, it } from "vitest";
import { locales } from "@mdbase-dev/i18n";
import { createEditorLocaleRuntime } from "./runtime";
import editorEnglish from "./locales/en/messages.json";
import { uiCatalogues } from "@mdbase-dev/ui/i18n";
import { connectUiCatalogues } from "@mdbase/connect-ui/i18n";

describe("editor catalogue composition", () => {
  it("loads both real English catalogues synchronously without overwriting the messages envelope", () => {
    const runtime = createEditorLocaleRuntime({ preferences: ["en"] });
    expect(runtime.i18n.locale).toBe("en");
    expect(Object.keys(uiCatalogues.english.messages).length).toBeGreaterThan(0);
    expect(Object.keys(connectUiCatalogues.english.messages).length).toBeGreaterThan(0);
    for (const catalogue of [uiCatalogues.english, connectUiCatalogues.english, editorEnglish]) {
      for (const [id, message] of Object.entries(catalogue.messages)) {
        expect(runtime.i18n.messages[id]).toEqual(message);
      }
    }
  });

  // This checks real chunk composition/collision handling, not PO completeness.
  // Raw authored-translation completeness remains a separate mandatory build gate.
  it.each(locales.filter((locale) => locale !== "en"))("atomically composes real %s chunks", async (locale) => {
    const runtime = createEditorLocaleRuntime({
      preferences: ["en"], storage: undefined,
      document: document.implementation.createHTMLDocument()
    });
    await runtime.selectLocale(locale);
    expect(runtime.i18n.locale).toBe(locale);
    expect(Object.keys(runtime.i18n.messages).length).toBeGreaterThan(0);
  });

  it("does not catalogue CSS classes or sidebar behavior identifiers", () => {
    const messages = Object.values(editorEnglish.messages);
    expect(messages).not.toContain("cm-task-checkbox mdbase-checkbox");
    expect(messages).not.toContain("show");
    expect(messages).not.toContain("hide");
  });
});
