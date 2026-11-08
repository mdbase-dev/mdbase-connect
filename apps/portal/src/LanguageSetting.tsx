import { useState } from "react";
import { t } from "@lingui/core/macro";
import { localeNames, locales, type Locale } from "@mdbase-dev/i18n";
import { useI18nRuntime } from "@mdbase-dev/i18n/react";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
import { Select } from "@mdbase-dev/ui/select";

const options = locales.map((locale) => ({ value: locale, label: localeNames[locale] }));

export function LanguageSetting() {
  useLocaleRevision();
  const runtime = useI18nRuntime();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const choose = (locale: Locale) => {
    setError(false);
    setBusy(true);
    void runtime.selectLocale(locale).catch(() => setError(true)).finally(() => setBusy(false));
  };
  return <span className="language-setting">
    <Select aria-label={t(i18n)`Language`} aria-busy={busy} className="theme-select" disabled={busy} value={i18n.locale as Locale} options={options} onChange={choose} />
    {error && <small role="alert">{t(i18n)`The language could not be loaded or saved. Try choosing it again.`}</small>}
  </span>;
}
