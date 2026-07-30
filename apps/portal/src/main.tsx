import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/azeret-mono/latin-400.css";
import "@fontsource/azeret-mono/latin-500.css";
import "@fontsource/azeret-mono/latin-600.css";
import "@mdbase/connect-ui/styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  ForgotPassword,
  Login,
  ResetPassword,
  Signup
} from "./auth-view";
import {
  AuthorityAdoption,
  AuthorityTransfer,
  MirrorPairing,
  Pairing
} from "./authority-workflows";
import { Authorization, DeviceAuthorization } from "./authorization-view";
import { Dashboard } from "./dashboard-view";
import "./styles.css";

function Portal() {
  const pairingId = location.pathname.match(/^\/pair\/([0-9a-f-]+)$/i)?.[1];
  const mirrorPairingId = location.pathname.match(/^\/mirror\/([0-9a-f-]+)$/i)?.[1];
  const authorityAdoptionId = location.pathname.match(/^\/adopt\/([0-9a-f-]+)$/i)?.[1];
  const authorityTransferId = location.pathname.match(/^\/transfer\/([0-9a-f-]+)$/i)?.[1];
  const authorizationId = location.pathname.match(/^\/authorize\/([0-9a-f-]+)$/i)?.[1];
  if (location.pathname === "/login") return <Login />;
  if (location.pathname === "/signup") return <Signup />;
  if (location.pathname === "/forgot-password") return <ForgotPassword />;
  if (location.pathname === "/reset-password") return <ResetPassword />;
  if (location.pathname === "/device") return <DeviceAuthorization />;
  if (pairingId) return <Pairing pairingId={pairingId} />;
  if (mirrorPairingId) return <MirrorPairing pairingId={mirrorPairingId} />;
  if (authorityAdoptionId) return <AuthorityAdoption adoptionId={authorityAdoptionId} />;
  if (authorityTransferId) return <AuthorityTransfer transferId={authorityTransferId} />;
  if (authorizationId) return <Authorization requestId={authorizationId} />;
  return <Dashboard />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Portal /></React.StrictMode>);
