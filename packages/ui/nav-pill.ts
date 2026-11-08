import { useLayoutEffect, type RefObject } from "react";

/** Slides the selected-item pill to the `aria-current` entry of its positioned nav. */
export function useNavPill(nav: RefObject<HTMLElement | null>, pill: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (!pill.current) return;
    const selected = nav.current?.querySelector<HTMLElement>("[aria-current='page']");
    pill.current.hidden = !selected;
    if (selected) pill.current.style.transform = `translateY(${selected.offsetTop}px)`;
  });
}
