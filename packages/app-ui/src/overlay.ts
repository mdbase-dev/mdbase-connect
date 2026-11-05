import { useLayoutEffect, useRef, useState } from "react";

export function useOverlay<Element extends HTMLElement>(open: boolean) {
  const ref = useRef<Element>(null);
  const [retained, setRetained] = useState(open);
  useLayoutEffect(() => {
    if (open) { setRetained(true); return; }
    // The resolved transition duration is always in seconds, whatever a build does to the token.
    const duration = ref.current ? parseFloat(getComputedStyle(ref.current).transitionDuration) * 1000 : 0;
    if (!duration) { setRetained(false); return; }
    const timeout = setTimeout(() => setRetained(false), duration);
    return () => clearTimeout(timeout);
  }, [open]);
  return { ref, present: open || retained };
}
