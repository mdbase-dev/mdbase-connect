import { Trans, useLingui } from "@lingui/react/macro";
import { localeNames, locales, type Locale } from "@mdbase-dev/i18n";
import { useI18nRuntime } from "@mdbase-dev/i18n/react";
import { Select } from "@mdbase-dev/ui/select";
import { useId, useState } from "react";

const options = locales.map((locale) => ({ value: locale, label: localeNames[locale] }));

export function LanguageSetting() {
  const { t, i18n } = useLingui();
  const runtime = useI18nRuntime();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const errorId = useId();
  const choose = (locale: Locale) => {
    setFailed(false);
    setBusy(true);
    void runtime.selectLocale(locale).catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  return <div className="setting-row">
    <div>
      <h3><Trans context="editor language preference">Language</Trans></h3>
      <p><Trans context="editor language preference">Choose the interface language for this browser. Your notes are not translated.</Trans></p>
      {failed && <p id={errorId} role="alert"><Trans context="editor language preference">The language choice could not be applied. Please try again.</Trans></p>}
    </div>
    <Select
      aria-label={t({ message: "Interface language", context: "editor language preference" })}
      aria-describedby={failed ? errorId : undefined}
      aria-busy={busy}
      disabled={busy}
      value={i18n.locale as Locale}
      options={options}
      onChange={choose}
    />
  </div>;
}
