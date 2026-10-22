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
import { createEditorMdbase, SdkEditorRoot } from "./SdkEditorRoot";
import { EnvironmentBadge } from "./EnvironmentBadge";
import { connectServerUrl } from "./connect-endpoint";
import { deliverAppGrantCallbackFrom, isAppGrantCallback } from "./private-collections";
import "@mdbase-dev/ui/motion.css";
import "./styles.css";
import "./environment-badge.css";

const EditorApp = lazy(() => import("./App").then((module) => ({ default: module.App })));
// The Connect console is retired from the Editor: accounts, access and collection
// management live on the Connect portal. Keep old /connect bookmarks working by
// forwarding them there, and never mount management (or an SDK owner) here.
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
const demoGateway = demoCount > 0 ? new DemoCollectionGateway(demoCount, demoDelay) : null;
const environment = import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "lab" : "production");
if (environment !== "lab" && environment !== "staging" && environment !== "production") throw new Error("Invalid Editor application environment");
// The explicit demo build has no native SDK owner; preserve its loopback E2E
// entry while applying exact target origins to every real native entry.
if (!demoGateway && ((environment === "staging" && location.origin !== "https://editor-staging.mdbase.dev")
  || (environment === "production" && location.origin !== "https://editor.mdbase.dev"))) {
  throw new Error("Invalid Editor application origin for its environment");
}
// The Private collection consent popup returns here: hand its result to the
// waiting editor tab and close, without starting a second SDK owner.
const grantCallback = !managementTarget && isAppGrantCallback(new URL(location.href));
if (grantCallback) {
  void deliverAppGrantCallbackFrom(new URL(location.href)).catch(() => {});
}
// One SDK owner for the module lifetime; construction does no registration IO.
const sdk = !managementTarget && !demoGateway && !grantCallback ? createEditorMdbase({ origin: location.origin, environment }) : null;

function EditorWorkspace() {
  const [context, setContext] = useState<{ surface: Surface; collectionName?: string }>({ surface: "notes" });
  const updateContext = useCallback((surface: Surface, collectionName?: string) => {
    setContext((previous) => previous.surface === surface && previous.collectionName === collectionName ? previous : { surface, collectionName });
  }, []);
  return <FeedbackProvider endpoint={feedbackEndpoint()} turnstileSiteKey={turnstileSiteKey()} application={feedbackApplication("mdbase editor", context.surface, import.meta.env.VITE_MDBASE_REVISION, import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "development" : "production"))} collectionName={context.collectionName}>
    <AppErrorBoundary>{grantCallback ? <p className="mdbase-connect-status">You can close this window.</p>
      : sdk ? <SdkEditorRoot sdk={sdk} onFeedbackContext={updateContext} />
      : demoGateway ? <EditorApp gateway={demoGateway} onFeedbackContext={updateContext} /> : null}</AppErrorBoundary>
  </FeedbackProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><AppErrorBoundary product="mdbase editor"><EnvironmentBadge /><Suspense fallback={<div className="route-loading" aria-live="polite">Opening mdbase…</div>}>{managementTarget ? <main aria-live="polite">Opening mdbase connect… <a href={managementTarget.href}>Continue</a></main> : <EditorWorkspace />}</Suspense></AppErrorBoundary></StrictMode>
);
