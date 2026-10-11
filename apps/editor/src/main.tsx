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
import { createEditorApplication, SdkEditorRoot } from "./SdkEditorRoot";
import { EnvironmentBadge } from "./EnvironmentBadge";
import "@mdbase-dev/ui/motion.css";
import "./styles.css";
import "./environment-badge.css";

const EditorApp = lazy(() => import("./App").then((module) => ({ default: module.App })));
const ConnectWorkspace = lazy(() => import("./ConnectApp").then((module) => ({ default: module.ConnectApp })));

const connectWorkspace = location.pathname === "/connect" || location.pathname.startsWith("/connect/");
const demoCount = !connectWorkspace && (import.meta.env.DEV || import.meta.env.VITE_MDBASE_EDITOR_DEMO === "1")
  ? Number(new URL(location.href).searchParams.get("demo") ?? 0)
  : 0;
const demoDelay = demoCount > 0
  ? Number(new URL(location.href).searchParams.get("delay") ?? 0)
  : 0;
const demoGateway = demoCount > 0 ? new DemoCollectionGateway(demoCount, demoDelay) : null;
const environment = import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "lab" : "production");
if (environment !== "lab" && environment !== "production") throw new Error("Invalid Editor application environment");
// One SDK owner for the module lifetime; construction does no registration IO.
const sdk = !connectWorkspace && !demoGateway ? createEditorApplication({ origin: location.origin, environment }) : null;

function EditorWorkspace() {
  const [context, setContext] = useState<{ surface: Surface; collectionName?: string }>({ surface: "notes" });
  const updateContext = useCallback((surface: Surface, collectionName?: string) => {
    setContext((previous) => previous.surface === surface && previous.collectionName === collectionName ? previous : { surface, collectionName });
  }, []);
  return <FeedbackProvider endpoint={feedbackEndpoint()} turnstileSiteKey={turnstileSiteKey()} application={feedbackApplication("mdbase editor", context.surface, import.meta.env.VITE_MDBASE_REVISION, import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "development" : "production"))} collectionName={context.collectionName}>
    <AppErrorBoundary>{sdk ? <SdkEditorRoot sdk={sdk} onFeedbackContext={updateContext} />
      : demoGateway ? <EditorApp gateway={demoGateway} onFeedbackContext={updateContext} /> : null}</AppErrorBoundary>
  </FeedbackProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><AppErrorBoundary product={connectWorkspace ? "mdbase connect" : "mdbase editor"}><EnvironmentBadge /><Suspense fallback={<div className="route-loading" aria-live="polite">Opening mdbase…</div>}>{connectWorkspace ? <ConnectWorkspace /> : <EditorWorkspace />}</Suspense></AppErrorBoundary></StrictMode>
);
