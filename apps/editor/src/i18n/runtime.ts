import { i18n } from "@lingui/core";
import { createI18nRuntime, type RuntimeOptions } from "@mdbase-dev/i18n";
import { uiCatalogues } from "@mdbase-dev/ui/i18n";
import { connectUiCatalogues } from "@mdbase/connect-ui/i18n";
import { editorCatalogues } from "./catalogues";

export const localeStorageKey = "mdbase-editor:locale";

export function createEditorLocaleRuntime(options: Partial<RuntimeOptions> = {}) {
  return createI18nRuntime({
    ...editorCatalogues,
    libraries: [uiCatalogues, connectUiCatalogues],
    storage: {
      getLocale: () => {
        // Browsers can deny storage access. Negotiation still works in that case.
        try { return localStorage.getItem(localeStorageKey); } catch { return null; }
      },
      setLocale: (locale) => localStorage.setItem(localeStorageKey, locale)
    },
    ...options
  });
}

// Shared controls and non-React core macros use this same instance.
export const editorLocaleRuntime = createEditorLocaleRuntime({ i18n });
