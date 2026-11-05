import { useEffect } from "react";
import { useFeedback } from "@mdbase-dev/ui/feedback";

/** Preserve existing /connect/feedback bookmarks without maintaining a second form. */
export function FeedbackPage({ onDone }: { onDone(): void }) {
  const { open } = useFeedback();
  useEffect(() => { onDone(); open(); }, [open, onDone]);
  return null;
}
