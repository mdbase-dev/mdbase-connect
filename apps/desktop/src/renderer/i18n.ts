import { createI18nRuntime } from "@mdbase-dev/i18n";
import { i18n, uiCatalogues } from "@mdbase-dev/ui/i18n";
import { connectUiCatalogues } from "@mdbase/connect-ui/i18n";
import { appCatalogues } from "../catalogues";
export const runtime = createI18nRuntime({
  ...appCatalogues, i18n, libraries: [uiCatalogues, connectUiCatalogues],
  storage: {
    getLocale: () => window.mdbaseConnect.getLocale(),
    setLocale: (locale) => window.mdbaseConnect.setLocale(locale),
  },
});
