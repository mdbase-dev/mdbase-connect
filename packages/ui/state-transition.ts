/**
 * Runs a synchronous DOM update as a view transition, so rows that leave, arrive
 * or shift move in place. Without support, or with reduced motion, it just updates.
 */
export function transitionState(update: () => void): void {
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  document.startViewTransition(update);
}
