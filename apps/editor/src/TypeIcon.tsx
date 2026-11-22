import { lazy, Suspense, type ReactNode } from "react";

// The glyph font is large: it loads with the first type icon drawn, not with the app.
const PhosphorIcon = lazy(() => import("./PhosphorIcon").then((module) => ({ default: module.PhosphorIcon })));

/** The icon a type declares (`collection.display.icon`), or `fallback` while
 * it loads and for a type without one. */
export function TypeIcon({ name, fallback = null }: { name?: string; fallback?: ReactNode }) {
  if (!name) return <>{fallback}</>;
  return <Suspense fallback={fallback}><PhosphorIcon name={name} aria-hidden="true" /></Suspense>;
}
