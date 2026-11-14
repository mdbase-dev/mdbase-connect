import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import "@mdbase-dev/ui/fonts.css";
import "@mdbase-dev/ui/live-preview.css";
import "@mdbase-dev/ui/tokens.css";
import "@mdbase-dev/ui/brand.css";
import "@mdbase-dev/ui/controls.css";
import "@mdbase-dev/ui/screens.css";
import "@mdbase-dev/ui/feedback.css";
import { lazy, StrictMode, Suspense, useCallback, useState } from "react";
import { FeedbackProvider, feedbackApplication } from "@mdbase-dev/ui/feedback";
import { feedbackEndpoint, turnstileSiteKey } from "./feedback";
import type { Surface } from "./app-state-types";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { DemoCollectionGateway } from "./demo-gateway";
import { createEditorMdbase, SdkEditorRoot } from "./SdkEditorRoot";
import { EnvironmentBadge } from "./EnvironmentBadge";
import { deliverAppGrantCallbackFrom, isAppGrantCallback } from "./private-collections";
import "@mdbase-dev/ui/motion.css";
import "@mdbase-dev/ui/palette.css";
import "@mdbase-dev/ui/toast.css";
import "@mdbase-dev/ui/comments.css";
import "./styles.css";
import "./environment-badge.css";
import { offlineShell } from "./offline-shell";
import { LocaleProvider } from "@mdbase-dev/i18n/react";
import { editorLocaleRuntime } from "./i18n/runtime";
import { EditorEntryPage } from "./ConnectionScreens";
import { configuredConnectServerUrl, editorPortalUrl } from "./connect-endpoint";
import { editorEnvironment as environment } from "./environment";
import { OpeningScreen } from "./LoadingScreens";

function reportLocaleLoadError(error: unknown) {
  console.warn("Editor language could not be loaded; keeping the current language.", error);
}

const EditorApp = lazy(() => import("./App").then((module) => ({ default: module.App })));
// The Connect console is retired from the Editor: accounts, access and collection
// management live on the Connect portal. Keep old /connect bookmarks working by
// forwarding them to this build's portal, and never mount management (or an SDK
// owner) here. A `?server=` value never chooses the destination, and the
// remainder is assigned as a path, never resolved as a URL reference, so the
// target always stays on the configured portal origin.
const portalUrl = editorPortalUrl();
const managementTarget = location.pathname === "/connect" || location.pathname.startsWith("/connect/")
  ? new URL(configuredConnectServerUrl) : null;
if (managementTarget) {
  managementTarget.pathname = location.pathname.slice("/connect".length) || "/";
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
// The explicit demo build has no native SDK owner; preserve its loopback E2E
// entry while applying exact target origins to every real native entry.
const wrongOrigin = !demoGateway && ((environment === "staging" && location.origin !== "https://editor-staging.mdbase.dev")
  || (environment === "production" && location.origin !== "https://editor.mdbase.dev"));
// The Private collection consent popup returns here: hand its result to the
// waiting editor tab and close, without starting a second SDK owner.
const grantCallback = !managementTarget && isAppGrantCallback(new URL(location.href));
if (grantCallback) {
  void deliverAppGrantCallbackFrom(new URL(location.href)).catch(() => {});
}
// One SDK owner for the module lifetime; construction does no registration IO.
const sdk = portalUrl && !wrongOrigin && !managementTarget && !demoGateway && !grantCallback ? createEditorMdbase({ origin: location.origin, environment }) : null;
// Pages that show the editor fetch its chunks while the SDK opens, not after:
// the lazy boundaries' own import() joins this in-flight module load. A failed
// load is reported by the boundary that renders it.
if (sdk || demoGateway) for (const chunk of [import("./App"), import("./CodeEditor")]) chunk.catch(() => {});

function EditorWorkspace() {
  useLingui();
  const [context, setContext] = useState<{ surface: Surface; collectionName?: string }>({ surface: "notes" });
  const updateContext = useCallback((surface: Surface, collectionName?: string) => {
    setContext((previous) => previous.surface === surface && previous.collectionName === collectionName ? previous : { surface, collectionName });
  }, []);
  return <FeedbackProvider endpoint={feedbackEndpoint()} turnstileSiteKey={turnstileSiteKey()} application={feedbackApplication("mdbase editor", context.surface, import.meta.env.VITE_MDBASE_REVISION, import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "development" : "production"))} collectionName={context.collectionName}>
    <AppErrorBoundary>{!portalUrl ? <EditorEntryPage title={t`This collection link is invalid`}><Trans>Return to Collections and open the collection again.</Trans></EditorEntryPage>
      : wrongOrigin ? <EditorEntryPage title={t`This Editor build cannot open collections here`}><Trans>Open the Editor configured for your mdbase environment from Collections.</Trans></EditorEntryPage>
      : grantCallback ? <p className="mdbase-connect-status"><Trans>You can close this window.</Trans></p>
      : sdk ? <SdkEditorRoot sdk={sdk} onFeedbackContext={updateContext} />
      : demoGateway ? <EditorApp gateway={demoGateway} onFeedbackContext={updateContext} /> : null}</AppErrorBoundary>
  </FeedbackProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><LocaleProvider runtime={editorLocaleRuntime} onError={reportLocaleLoadError}><AppErrorBoundary product="mdbase editor"><EnvironmentBadge /><Suspense fallback={<OpeningScreen />}>{managementTarget ? <main aria-live="polite"><Trans>Opening mdbase connect… <a href={managementTarget.href}>Continue</a></Trans></main> : <EditorWorkspace />}</Suspense></AppErrorBoundary></LocaleProvider></StrictMode>
);
// Collection screens register the offline shell once usable; others after a delay.
if (!managementTarget) offlineShell.start();
