import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import { useEffect } from "react";
import { FeedbackButton, useFeedback } from "@mdbase-dev/ui/feedback";
import { ConnectPage } from "./ConnectPrimitives";

/** Preserve existing /connect/feedback bookmarks without maintaining a second form. */
export function FeedbackPage({ onDone }: { onDone(): void }) {
  useLocaleRevision();
  const { open } = useFeedback();
  useEffect(() => { open(); }, [open]);
  return <ConnectPage title={t(i18n)({ message: "Send feedback", context: "Connect interface" })} intro={t(i18n)({ message: "Feedback goes privately to the mdbase team." })}>
    <section><FeedbackButton /><button type="button" onClick={onDone}><Trans>Back to Connect</Trans></button></section>
  </ConnectPage>;
}
