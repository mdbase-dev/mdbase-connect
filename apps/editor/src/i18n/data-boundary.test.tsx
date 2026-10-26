import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { i18n } from "@lingui/core";
import { LocaleProvider } from "@mdbase-dev/i18n/react";
import type { CollectionContractDescriptor } from "@mdbase-dev/connect";
import { describe, expect, it, vi } from "vitest";
import { createEditorLocaleRuntime } from "./runtime";
import { NewNoteComposer } from "../NewNoteComposer";
import { persistedBody, titlePatch } from "../note";
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
      expect(titlePatch(" ", { kind: "frontmatter", field: "/profile/name" }, { profile: { keep: true } }))
        .toEqual({ profile: { keep: true, name: "Untitled" } });
      expect(persistedBody("Senza titolo, ma mio", "Body", { kind: "heading" }))
        .toBe("# Senza titolo, ma mio\n\nBody");
      expect(persistedBody("Display stand-in", "Body", { kind: "path", title: "Display stand-in" })).toBe("Body");
    } finally {
      await runtime.selectLocale("en");
    }
  });

  it("keeps the default filename stable when its folder is edited before the title", async () => {
    const runtime = createRuntime();
    await runtime.initialize();
    await runtime.selectLocale("it");
    const onCreate = vi.fn(async () => undefined);
    const view = render(<LocaleProvider runtime={runtime} onError={(error) => { throw error; }}>
      <NewNoteComposer types={[]} onCreate={onCreate} onCancel={() => undefined} />
    </LocaleProvider>);
    try {
      const title = view.container.querySelector<HTMLInputElement>(".new-note-title input")!;
      expect(title.placeholder).not.toBe("Untitled");
      const path = view.container.querySelector<HTMLInputElement>(".new-note-path input")!;
      fireEvent.change(path, { target: { value: `Inbox/${path.value}` } });
      fireEvent.change(title, { target: { value: "Il mio titolo" } });
      fireEvent.submit(view.container.querySelector("form")!);
      await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
      expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Il mio titolo", path: "Inbox/Untitled.md" }));
    } finally {
      view.unmount();
      await act(() => runtime.selectLocale("en"));
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
