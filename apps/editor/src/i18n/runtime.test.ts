import { describe, expect, it } from "vitest";
import { createEditorLocaleRuntime } from "./runtime";
import editorEnglish from "./locales/en/messages.json";
import sharedEnglish from "./shared/en.json";

describe("editor catalogue composition", () => {
  it("loads both real English catalogues synchronously without overwriting the messages envelope", () => {
    const runtime = createEditorLocaleRuntime({ preferences: ["en"] });
    expect(runtime.i18n.locale).toBe("en");
    expect(Object.keys(sharedEnglish.messages).length).toBeGreaterThan(0);
    for (const catalogue of [sharedEnglish, editorEnglish]) {
      for (const [id, message] of Object.entries(catalogue.messages)) {
        expect(runtime.i18n.messages[id]).toEqual(message);
      }
    }
  });

  it("does not catalogue CSS classes or sidebar behavior identifiers", () => {
    const messages = Object.values(editorEnglish.messages);
    expect(messages).not.toContain("cm-task-checkbox mdbase-checkbox");
    expect(messages).not.toContain("show");
    expect(messages).not.toContain("hide");
  });
});
