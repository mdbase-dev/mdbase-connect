import { useState } from "react";
import { t } from "@lingui/core/macro";
import { LanguagePicker } from "@mdbase-dev/i18n/react";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
export function LanguageSetting() {
  useLocaleRevision();
  const [error, setError] = useState(false);
  return <span className="language-setting">
    <LanguagePicker className="theme-select" label={t(i18n)`Language`} onChangeCapture={() => setError(false)} onError={() => setError(true)} />
    {error && <small role="alert">{t(i18n)`The language could not be loaded or saved. Try choosing it again.`}</small>}
  </span>;
}
