import { useEffect, useState } from "react";

// Routine writes stay quiet. Reset the delay when navigating to another document.
export function useDelayedBusy(busy: boolean, identity?: string): boolean {
  const [slow, setSlow] = useState<{ identity?: string }>();
  useEffect(() => {
    setSlow(undefined);
    if (!busy) return;
    const timer = window.setTimeout(() => setSlow({ identity }), 1_500);
    return () => window.clearTimeout(timer);
  }, [busy, identity]);
  return busy && slow !== undefined && slow.identity === identity;
}
