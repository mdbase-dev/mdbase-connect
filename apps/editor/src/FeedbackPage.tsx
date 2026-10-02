import { useEffect } from "react";
import { FeedbackButton, useFeedback } from "@mdbase-dev/ui/feedback";
import { ConnectPage } from "./ConnectPrimitives";

/** Preserve existing /connect/feedback bookmarks without maintaining a second form. */
export function FeedbackPage({ onDone }: { onDone(): void }) {
  const { open } = useFeedback();
  useEffect(() => { open(); }, [open]);
  return <ConnectPage title="Send feedback" intro="Feedback goes privately to the mdbase team.">
    <section><FeedbackButton /><button type="button" onClick={onDone}>Back to Connect</button></section>
  </ConnectPage>;
}
