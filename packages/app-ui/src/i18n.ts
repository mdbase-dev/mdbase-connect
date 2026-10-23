import { i18n } from "@lingui/core";
import { useSyncExternalStore } from "react";

// Existing consumers without a language setting still receive synchronous English.
// Apps adopting the shared runtime load their own complete catalogues into this instance.
if (!i18n.locale) {
  i18n.load("en", {});
  i18n.activate("en");
}
let revision = 0;
i18n.on("change", () => { revision += 1; });
const subscribe = (notify: () => void) => i18n.on("change", notify);
const snapshot = () => revision;

/** Presentation helpers use Lingui's singleton; changing language never remounts a form. */
export function useLocaleRevision(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
