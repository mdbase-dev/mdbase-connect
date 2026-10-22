import "@mdbase-dev/ui/fonts.css";
import "@mdbase/connect-ui/styles.css";
import "@mdbase-dev/ui/motion.css";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  ForgotPassword,
  Login,
  ResetPassword,
  Signup,
  Unsubscribe
} from "./auth-view";
import {
  AuthorityAdoption,
  AuthorityTransfer,
  MirrorPairing,
  Pairing
} from "./authority-workflows";
import { Authorization, DeviceAuthorization } from "./authorization-view";
import {
  capturePortalBootstrapSecrets,
  type PortalBootstrapSecrets
} from "./portal-model";
import { GettingStarted } from "./onboarding-view";
import "./styles.css";
import "./authorization.css";

const ConnectApp = React.lazy(() => import("./ConnectApp").then(module => ({ default: module.ConnectApp })));

function Portal({ bootstrapSecrets }: { bootstrapSecrets: PortalBootstrapSecrets }) {
  const pairingId = location.pathname.match(/^\/pair\/([0-9a-f-]+)$/i)?.[1];
  const mirrorPairingId = location.pathname.match(/^\/mirror\/([0-9a-f-]+)$/i)?.[1];
  const authorityAdoptionId = location.pathname.match(/^\/adopt\/([0-9a-f-]+)$/i)?.[1];
  const authorityTransferId = location.pathname.match(/^\/transfer\/([0-9a-f-]+)$/i)?.[1];
  const authorizationId = location.pathname.match(/^\/authorize\/([0-9a-f-]+)$/i)?.[1];
  if (location.pathname === "/login") return <Login />;
  if (location.pathname === "/signup") return <Signup
    invitationToken={bootstrapSecrets.invitationToken}
    verificationToken={bootstrapSecrets.verificationToken}
  />;
  if (location.pathname === "/getting-started") return <GettingStarted />;
  if (location.pathname === "/forgot-password") return <ForgotPassword />;
  if (location.pathname === "/reset-password") return <ResetPassword resetToken={bootstrapSecrets.resetToken} />;
  if (location.pathname === "/unsubscribe") return <Unsubscribe unsubscribeToken={bootstrapSecrets.unsubscribeToken} />;
  if (location.pathname === "/device") return <DeviceAuthorization />;
  if (pairingId) return <Pairing pairingId={pairingId} />;
  if (mirrorPairingId) return <MirrorPairing pairingId={mirrorPairingId} />;
  if (authorityAdoptionId) return <AuthorityAdoption adoptionId={authorityAdoptionId} />;
  if (authorityTransferId) return <AuthorityTransfer transferId={authorityTransferId} />;
  if (authorizationId) return <Authorization requestId={authorizationId} />;
  return <React.Suspense fallback={<main className="portal-redirect" aria-live="polite">Opening mdbase connect…</main>}><ConnectApp /></React.Suspense>;
}

const bootstrapSecrets = capturePortalBootstrapSecrets();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode><Portal bootstrapSecrets={bootstrapSecrets} /></React.StrictMode>
);
