import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/azeret-mono/latin-400.css";
import "@fontsource/azeret-mono/latin-500.css";
import "@fontsource/azeret-mono/latin-600.css";
import "@mdbase/connect-ui/styles.css";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ForgotPassword,
  Login,
  ResetPassword,
  Signup
} from "./auth-view";
import { DeletedAccount } from "./account-view";
import {
  AuthorityAdoption,
  AuthorityTransfer,
  MirrorPairing,
  Pairing
} from "./authority-workflows";
import { Authorization, DeviceAuthorization } from "./authorization-view";
import { Dashboard, type PortalView } from "./dashboard-view";
import "./styles.css";

const dashboardViews: Record<string, PortalView> = {
  "/": "overview",
  "/requests": "requests",
  "/hosted-collections": "hosted",
  "/app-access": "permissions",
  "/computers": "computers",
  "/account": "account"
};

function Portal() {
  const [pathname, setPathname] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPathname(location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  const pairingId = pathname.match(/^\/pair\/([0-9a-f-]+)$/i)?.[1];
  const mirrorPairingId = pathname.match(/^\/mirror\/([0-9a-f-]+)$/i)?.[1];
  const authorityAdoptionId = pathname.match(/^\/adopt\/([0-9a-f-]+)$/i)?.[1];
  const authorityTransferId = pathname.match(/^\/transfer\/([0-9a-f-]+)$/i)?.[1];
  const authorizationId = pathname.match(/^\/authorize\/([0-9a-f-]+)$/i)?.[1];
  if (pathname === "/login") return <Login />;
  if (pathname === "/signup") return <Signup />;
  if (pathname === "/forgot-password") return <ForgotPassword />;
  if (pathname === "/reset-password") return <ResetPassword />;
  if (pathname === "/device") return <DeviceAuthorization />;
  if (pairingId) return <Pairing pairingId={pairingId} />;
  if (mirrorPairingId) return <MirrorPairing pairingId={mirrorPairingId} />;
  if (authorityAdoptionId) return <AuthorityAdoption adoptionId={authorityAdoptionId} />;
  if (authorityTransferId) return <AuthorityTransfer transferId={authorityTransferId} />;
  if (authorizationId) return <Authorization requestId={authorizationId} />;
  if (pathname === "/account-deleted") return <DeletedAccount />;
  return <Dashboard view={dashboardViews[pathname] ?? "overview"} onNavigate={(nextPath) => {
    if (location.pathname !== nextPath) history.pushState({}, "", nextPath);
    setPathname(nextPath);
    window.scrollTo(0, 0);
  }} />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Portal /></React.StrictMode>);
