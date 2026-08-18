// Google Identity Services renders its own button at a fixed pixel width and
// clamps whatever it is given. Sharing the clamp here keeps the rendered widget
// the same width as the outlined provider buttons stacked beside it.
export const providerButtonMinWidth = 240;
export const providerButtonMaxWidth = 400;

export function providerButtonWidth(available: number): number {
  return Math.min(
    providerButtonMaxWidth,
    Math.max(providerButtonMinWidth, Math.floor(available))
  );
}

export function observeProviderWidth(
  element: HTMLElement | null,
  onWidth: (width: number) => void
): () => void {
  if (!element || typeof ResizeObserver !== "function") return () => {};
  const observer = new ResizeObserver(([entry]) => {
    if (entry) onWidth(providerButtonWidth(entry.contentRect.width));
  });
  observer.observe(element);
  return () => observer.disconnect();
}
