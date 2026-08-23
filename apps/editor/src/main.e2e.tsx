import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

if (location.pathname === "/collaboration-harness") {
  const { CollaborationBrowserHarness } = await import("./CollaborationBrowserHarness");
  createRoot(document.getElementById("root")!).render(
    <StrictMode><CollaborationBrowserHarness /></StrictMode>
  );
} else {
  await import("./main");
}
