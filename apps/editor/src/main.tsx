import "@mdbase-dev/ui/fonts.css";
import "@mdbase-dev/ui/tokens.css";
import "@mdbase-dev/ui/brand.css";
import "@mdbase-dev/ui/controls.css";
import "@mdbase-dev/ui/screens.css";
import { lazy, StrictMode, Suspense, useCallback, useState } from "react";
import { FeedbackProvider, feedbackApplication } from "@mdbase-dev/ui/feedback";
import { feedbackEndpoint, turnstileSiteKey } from "./feedback";
import type { Surface } from "./app-state-types";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { DemoCollectionGateway } from "./demo-gateway";
import { ConnectCollectionGateway } from "./gateway";
import { EnvironmentBadge } from "./EnvironmentBadge";
import { connectServerUrl } from "./connect-endpoint";
import "@mdbase-dev/ui/motion.css";
import "./styles.css";
import "./environment-badge.css";

const EditorApp = lazy(() => import("./App").then((module) => ({ default: module.App })));
// Keep old bookmarks, but never mount account management in the Editor.
const managementTarget = location.pathname === "/connect" || location.pathname.startsWith("/connect/")
  ? new URL(location.pathname.slice("/connect".length) || "/", connectServerUrl()) : null;
if (managementTarget) {
  managementTarget.search = location.search;
  managementTarget.searchParams.delete("server");
  managementTarget.hash = location.hash;
  location.replace(managementTarget.href);
}
const demoCount = !managementTarget && (import.meta.env.DEV || import.meta.env.VITE_MDBASE_EDITOR_DEMO === "1")
  ? Number(new URL(location.href).searchParams.get("demo") ?? 0)
  : 0;
const demoDelay = demoCount > 0
  ? Number(new URL(location.href).searchParams.get("delay") ?? 0)
  : 0;
const gateway = managementTarget ? null : demoCount > 0
  ? new DemoCollectionGateway(demoCount, demoDelay)
  : new ConnectCollectionGateway();

function EditorWorkspace() {
  const [context, setContext] = useState<{ surface: Surface; collectionName?: string }>({ surface: "notes" });
  const updateContext = useCallback((surface: Surface, collectionName?: string) => {
    setContext((previous) => previous.surface === surface && previous.collectionName === collectionName ? previous : { surface, collectionName });
  }, []);
  return <FeedbackProvider endpoint={feedbackEndpoint()} turnstileSiteKey={turnstileSiteKey()} application={feedbackApplication("mdbase editor", context.surface, import.meta.env.VITE_MDBASE_REVISION, import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "development" : "production"))} collectionName={context.collectionName}>
    <AppErrorBoundary><EditorApp gateway={gateway!} onFeedbackContext={updateContext} /></AppErrorBoundary>
  </FeedbackProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><AppErrorBoundary><EnvironmentBadge /><Suspense fallback={<div className="route-loading" aria-live="polite">Opening mdbase…</div>}>{managementTarget ? <main aria-live="polite">Opening mdbase connect… <a href={managementTarget.href}>Continue</a></main> : <EditorWorkspace />}</Suspense></AppErrorBoundary></StrictMode>
);
