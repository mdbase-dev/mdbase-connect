import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/azeret-mono/latin-500.css";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { DemoCollectionGateway } from "./demo-gateway";
import { ConnectCollectionGateway } from "./gateway";
import "@mdbase/connect-ui/motion.css";
import "./phosphor-icons.generated.css";
import "./styles.css";

const EditorApp = lazy(() => import("./App").then((module) => ({ default: module.App })));
const ConnectWorkspace = lazy(() => import("./ConnectApp").then((module) => ({ default: module.ConnectApp })));

const connectWorkspace = location.pathname === "/connect" || location.pathname.startsWith("/connect/");
const demoCount = !connectWorkspace && (import.meta.env.DEV || import.meta.env.VITE_MDBASE_EDITOR_DEMO === "1")
  ? Number(new URL(location.href).searchParams.get("demo") ?? 0)
  : 0;
const demoDelay = demoCount > 0
  ? Number(new URL(location.href).searchParams.get("delay") ?? 0)
  : 0;
const gateway = demoCount > 0
  ? new DemoCollectionGateway(demoCount, demoDelay)
  : new ConnectCollectionGateway();

createRoot(document.getElementById("root")!).render(
  <StrictMode><AppErrorBoundary><Suspense fallback={<div className="route-loading" aria-live="polite">Opening mdbase…</div>}>{connectWorkspace ? <ConnectWorkspace /> : <EditorApp gateway={gateway} />}</Suspense></AppErrorBoundary></StrictMode>
);
