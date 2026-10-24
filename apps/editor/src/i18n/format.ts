import { i18n } from "@lingui/core";

/** Display formatting only; stored paths, timestamps and protocol values stay unchanged. */
export function displayLocale(): string {
  return i18n.locale === "pt" ? "pt-BR" : i18n.locale === "zh" ? "zh-CN" : i18n.locale || "en";
}
