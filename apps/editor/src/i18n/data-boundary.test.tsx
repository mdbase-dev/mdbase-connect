import { i18n } from "@lingui/core";
import type { CollectionContractDescriptor } from "@mdbase-dev/connect";
import { describe, expect, it } from "vitest";
import { createEditorLocaleRuntime } from "./runtime";
import { newNoteForm, newNotePath, occupiedPaths, titledPath } from "../new-note";
import { persistedBody, titlePatch, untitledPath } from "../note";
import { createTypeSourceFromContract } from "../type-contracts";
import { NEW_TYPE_SOURCE } from "../type-presentation";
import { readVisualType } from "../type-schema";

const contract: CollectionContractDescriptor = {
  contractType: "record", id: "example.person", version: "1.0.0", digest: `sha256:${"1".repeat(64)}`, implementations: [], schema: {
    type: "object", properties: { name: { type: "string", description: "Nome scelto dall’utente" } }
  }
};

function createRuntime() {
  return createEditorLocaleRuntime({ i18n, preferences: ["en"], storage: undefined });
}

describe("translated display copy stays out of editor data", () => {
  it.each(["fr", "it"] as const)("keeps empty-title writes stable in %s", async (locale) => {
    const runtime = createRuntime();
    try {
      await runtime.selectLocale(locale);
      expect(persistedBody("", "Body", { kind: "heading" })).toBe("# Untitled\n\nBody");
      expect(titlePatch(" ", { kind: "frontmatter", field: "/profile/name" }, { profile: { keep: true, name: "Ada" } }))
        .toEqual({ profile: { keep: true, name: "Untitled" } });
      expect(persistedBody("Senza titolo, ma mio", "Body", { kind: "heading" }))
        .toBe("# Senza titolo, ma mio\n\nBody");
      expect(persistedBody("Display stand-in", "Body", { kind: "path", title: "Display stand-in" })).toBe("Body");
    } finally {
      await runtime.selectLocale("en");
    }
  });

  it("keeps the placeholder file name stable in every language", async () => {
    const runtime = createRuntime();
    await runtime.initialize();
    try {
      await runtime.selectLocale("it");
      const path = newNotePath({ title: "", folder: "Inbox" }, newNoteForm(undefined, []), occupiedPaths([]));
      expect(path).toBe("Inbox/Untitled.md");
      expect(untitledPath(path)).toBe(true);
      expect(titledPath(path, "Il mio titolo", occupiedPaths([path]))).toBe("Inbox/Il mio titolo.md");
    } finally {
      await runtime.selectLocale("en");
    }
  });

  it("generates identical type source in English and Italian, preserving contract-authored text", async () => {
    const runtime = createRuntime();
    const english = createTypeSourceFromContract(NEW_TYPE_SOURCE, contract);
    try {
      await runtime.selectLocale("it");
      const italian = createTypeSourceFromContract(NEW_TYPE_SOURCE, contract);
      expect(italian).toBe(english);
      expect(readVisualType(italian).description).toBe("Implements example.person 1.0.0.");
      expect(readVisualType(italian).fields[0].description).toBe("Nome scelto dall’utente");
    } finally {
      await runtime.selectLocale("en");
    }
  });
});
