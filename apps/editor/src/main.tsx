import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/azeret-mono/latin-500.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import { ConnectCollectionGateway } from "./gateway";
import "./styles.css";

const demoCount = import.meta.env.DEV || import.meta.env.VITE_MDBASE_EDITOR_DEMO === "1"
  ? Number(new URL(location.href).searchParams.get("demo") ?? 0)
  : 0;
const gateway = demoCount > 0
  ? new DemoCollectionGateway(demoCount)
  : new ConnectCollectionGateway();

createRoot(document.getElementById("root")!).render(
  <StrictMode><App gateway={gateway} /></StrictMode>
);
