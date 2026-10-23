import { I18nProvider, useLingui } from "@lingui/react";
import { createContext, useContext, useEffect, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { isLocale, localeNames, locales, type I18nRuntime } from "./runtime.js";

const RuntimeContext = createContext<I18nRuntime | null>(null);
export function LocaleProvider({ runtime, onError, children }: {
  runtime: I18nRuntime; onError: (error: unknown) => void; children: ReactNode;
}) {
  useEffect(() => { void runtime.initialize().catch(onError); }, [runtime, onError]);
  return <RuntimeContext.Provider value={runtime}>
    <I18nProvider i18n={runtime.i18n}>{children}</I18nProvider>
  </RuntimeContext.Provider>;
}
export function useI18nRuntime(): I18nRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("useI18nRuntime requires LocaleProvider");
  return runtime;
}
/** Native, unstyled select. The app supplies translated label and load-error UI. */
export function LanguagePicker({ label, onError, disabled, ...props }:
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "defaultValue" | "onChange" | "aria-label"> &
  { label: string; onError: (error: unknown) => void }) {
  const runtime = useI18nRuntime();
  const { i18n } = useLingui();
  const [busy, setBusy] = useState(false);
  return <select {...props} aria-label={label} value={i18n.locale} disabled={disabled || busy} aria-busy={busy}
    onChange={(event) => {
      const locale = event.currentTarget.value;
      if (!isLocale(locale)) return;
      setBusy(true);
      void runtime.selectLocale(locale).catch(onError).finally(() => setBusy(false));
    }}>
    {locales.map((locale) => <option key={locale} value={locale} lang={locale}>{localeNames[locale]}</option>)}
  </select>;
}
