import { Trans, useLingui } from "@lingui/react/macro";
import { LanguagePicker } from "@mdbase-dev/i18n/react";
import { useId, useState } from "react";

export function LanguageSetting() {
  const { t } = useLingui();
  const [failed, setFailed] = useState(false);
  const errorId = useId();
  return <div className="setting-row">
    <div>
      <h3><Trans context="editor language preference">Language</Trans></h3>
      <p><Trans context="editor language preference">Choose the interface language for this browser. Your notes are not translated.</Trans></p>
      {failed && <p id={errorId} role="alert"><Trans context="editor language preference">The language choice could not be applied. Please try again.</Trans></p>}
    </div>
    <LanguagePicker
      className="mdbase-select"
      label={t({ message: "Interface language", context: "editor language preference" })}
      aria-describedby={failed ? errorId : undefined}
      onInput={() => setFailed(false)}
      onError={() => setFailed(true)}
    />
  </div>;
}
