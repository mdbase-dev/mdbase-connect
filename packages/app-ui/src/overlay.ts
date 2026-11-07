import { useLayoutEffect, useRef, useState } from "react";

export function useOverlay<Element extends HTMLElement>(open: boolean) {
  const ref = useRef<Element>(null);
  const [retained, setRetained] = useState(open);
  useLayoutEffect(() => {
    if (open) { setRetained(true); return; }
    const animations = ref.current?.getAnimations() ?? [];
    if (animations.length === 0) { setRetained(false); return; }
    let cancelled = false;
    void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (!cancelled) setRetained(false);
    });
    return () => { cancelled = true; };
  }, [open]);
  return { ref, present: open || retained };
}
