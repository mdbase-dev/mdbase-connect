import "@mdbase-dev/ui/tokens.css";
import "@mdbase-dev/ui/brand.css";
import "@mdbase-dev/ui/controls.css";
import "@mdbase-dev/ui/screens.css";
import "@mdbase-dev/ui/properties.css";
import "@mdbase-dev/ui/live-preview.css";
import "./styles.css";

import { t } from "@lingui/core/macro";
import { LocaleProvider } from "@mdbase-dev/i18n/react";
import { OpeningScreen } from "@mdbase-dev/ui/screens";
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appHost } from "./host";
import { viewRuntime } from "./i18n";
import { changesOf, isObject, shownResult, type Json } from "./model";
import { View } from "./View";

const app = new App({ name: "mdbase", version: "1" }, {}, { autoResize: true });
const host = appHost(app);
const root = createRoot(document.getElementById("root")!);
let args: Json | undefined;
let result: Parameters<typeof shownResult>[0] | undefined;
let runtime: ReturnType<typeof viewRuntime> | undefined;

app.ontoolinput = ({ arguments: input }) => {
  args = input ?? {};
  render();
};
app.ontoolresult = (toolResult) => {
  result = toolResult;
  render();
};
app.onhostcontextchanged = (context) => {
  applyHost(context);
  render();
};

function applyHost(context: McpUiHostContext | undefined): void {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
}

function render(): void {
  if (!runtime) return;
  const context = app.getHostContext();
  // The result names its connection only through the arguments the tool was called with.
  const connectionId = isObject(args) && typeof args.connection_id === "string" ? args.connection_id : "";
  const display = { full: context?.displayMode === "fullscreen", canFill: context?.availableDisplayModes?.includes("fullscreen") === true };
  root.render(<StrictMode>
    {/* Every catalogue is in the page, so a language that fails to load is a build fault: say so and stay in English. */}
    <LocaleProvider runtime={runtime} onError={(error) => console.error(error)}>
      {result && args
        ? <View host={host} display={display} first={{ id: 0, connectionId, args, shown: shownResult(result, args), changes: changesOf(context?.toolInfo?.tool.name, args) }} />
        : <Waiting />}
    </LocaleProvider>
  </StrictMode>);
}

function Waiting() {
  return <OpeningScreen app={{ name: "mdbase" }} layout="panel" title={t`Asking the collection`} />;
}

await app.connect();
const context = app.getHostContext();
applyHost(context);
runtime = viewRuntime(context?.locale);
render();
