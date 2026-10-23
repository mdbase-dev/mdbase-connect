import { useState } from "react";
import { t } from "@lingui/core/macro";
import { LanguagePicker } from "@mdbase-dev/i18n/react";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
export function LanguageSetting() {
  useLocaleRevision();
  const [error, setError] = useState(false);
  return <div className="setting-row">
    <span>{t(i18n)`Language`}</span>
    <div>{error && <small role="alert">{t(i18n)`The language could not be loaded or saved. Try choosing it again.`}</small>}</div>
    <LanguagePicker className="theme-select" label={t(i18n)`Language`} onChangeCapture={() => setError(false)} onError={() => setError(true)} />
  </div>;
}
