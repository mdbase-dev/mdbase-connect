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
import type { CollectionGateway } from "./model";
import "@mdbase-dev/ui/motion.css";
import "./styles.css";
import "./environment-badge.css";

const EditorApp = lazy(() => import("./App").then((module) => ({ default: module.App })));
const ConnectWorkspace = lazy(() => import("./ConnectApp").then((module) => ({ default: module.ConnectApp })));

const connectWorkspace = location.pathname === "/connect" || location.pathname.startsWith("/connect/");
const demoAllowed = import.meta.env.DEV || import.meta.env.VITE_MDBASE_EDITOR_DEMO === "1";
const demoCount = !connectWorkspace && demoAllowed
  ? Number(new URL(location.href).searchParams.get("demo") ?? 0)
  : 0;
const demoDelay = demoCount > 0
  ? Number(new URL(location.href).searchParams.get("delay") ?? 0)
  : 0;
/**
 * Opt-in mdbase-next backends until cutover: `?backend=next` (relay, needs the
 * control plane) or `?backend=next-demo` (in-memory replica, no server). A build
 * can opt in with VITE_MDBASE_EDITOR_BACKEND. The default stays Connect.
 */
const requestedBackend = new URL(location.href).searchParams.get("backend") ?? import.meta.env.VITE_MDBASE_EDITOR_BACKEND;
const nextBackend = connectWorkspace || demoCount > 0 ? undefined
  : requestedBackend === "next-demo" && demoAllowed ? "next-demo" as const
    : requestedBackend === "next" && (demoAllowed || import.meta.env.VITE_MDBASE_EDITOR_BACKEND === "next") ? "next" as const
      : undefined;
let gateway: CollectionGateway | undefined = nextBackend ? undefined
  : demoCount > 0 ? new DemoCollectionGateway(demoCount, demoDelay)
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

const root = createRoot(document.getElementById("root")!);
const render = () => root.render(
  <StrictMode><AppErrorBoundary product={connectWorkspace ? "mdbase connect" : "mdbase editor"}><EnvironmentBadge /><Suspense fallback={<div className="route-loading" aria-live="polite">Opening mdbase…</div>}>{connectWorkspace ? <ConnectWorkspace /> : <EditorWorkspace />}</Suspense></AppErrorBoundary></StrictMode>
);
if (nextBackend) {
  // The SDK loads only for the opt-in backends.
  root.render(<div className="route-loading" aria-live="polite">Opening mdbase…</div>);
  void import("./next-backend").then((module) => module.createNextGateway(nextBackend)).then((next) => {
    gateway = next;
    render();
  }, (error: unknown) => {
    root.render(<div className="route-loading" role="alert">The mdbase-next backend couldn’t load. {error instanceof Error ? error.message : ""}</div>);
  });
} else render();
