import { LocaleProvider } from "@mdbase-dev/i18n/react";
import { fireEvent, render, screen, waitFor } from "../test/locale";
import { describe, expect, it, vi } from "vitest";
import { DemoCollectionGateway } from "../demo-gateway";
import { defaultPreferences } from "../preferences";
import { SettingsView } from "../settings/SettingsView";
import { LanguageSetting } from "./LanguageSetting";
import english from "./locales/en/messages.json";
import { uiCatalogues } from "@mdbase-dev/ui/i18n";
import { connectUiCatalogues } from "@mdbase/connect-ui/i18n";
import { createEditorLocaleRuntime, localeStorageKey } from "./runtime";

describe("editor language preference", () => {
  it("renders English immediately without a locale download", () => {
    const loadLocale = vi.fn();
    const runtime = createEditorLocaleRuntime({ preferences: ["en"], loadLocale });
    render(<LocaleProvider runtime={runtime} onError={vi.fn()}><LanguageSetting /></LocaleProvider>);
    expect(screen.getByRole("combobox", { name: "Interface language" })).toHaveValue("en");
    expect(loadLocale).not.toHaveBeenCalled();
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getAllByRole("option")).toHaveLength(10);
  });

  it("preserves the active language and saved choice after a failed download", async () => {
    localStorage.setItem(localeStorageKey, "en");
    const runtime = createEditorLocaleRuntime({ preferences: ["en"], loadLocale: async () => { throw new Error("offline"); } });
    render(<LocaleProvider runtime={runtime} onError={vi.fn()}><LanguageSetting /></LocaleProvider>);
    const picker = screen.getByRole("combobox", { name: "Interface language" });
    fireEvent.change(picker, { target: { value: "ja" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("The language choice could not be applied. Please try again.");
    await waitFor(() => expect(picker).not.toBeDisabled());
    expect(picker).toHaveValue("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem(localeStorageKey)).toBe("en");
  });

  it("updates locale formatting and persistence without remounting a draft", async () => {
    const gateway = new DemoCollectionGateway(12);
    const description = await gateway.describe();
    // Transport fixture only: actual compiled English ICU data for ALL sources.
    // Mixing the app English fixture with real German library messages would
    // correctly fail the kit’s conflicting-ID guard. This verifies preference
    // state/formatting, not German completeness; real chunks are tested separately.
    const runtime = createEditorLocaleRuntime({
      preferences: ["en"], loadLocale: async () => english,
      libraries: [uiCatalogues, connectUiCatalogues].map((source) => ({
        ...source, loadLocale: async () => source.english
      }))
    });
    render(<LocaleProvider runtime={runtime} onError={vi.fn()}>
      <input aria-label="Draft" defaultValue="My unsaved note" />
      <SettingsView description={description} connection={null} noteCount={1234567}
        preferences={defaultPreferences} directAccessBusy={false} onChange={vi.fn()}
        onBack={vi.fn()} onForget={vi.fn()} onRequestDirectAccess={vi.fn()} />
    </LocaleProvider>);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "Still unsaved, 日本語" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Interface language" }), { target: { value: "de" } });
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));
    expect(screen.getByText("1.234.567")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("Still unsaved, 日本語");
    expect(localStorage.getItem(localeStorageKey)).toBe("de");
  });
});
