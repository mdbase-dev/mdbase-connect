import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { t } from "@lingui/core/macro";
import { i18n } from "@lingui/core";
import { createI18nRuntime } from "@mdbase-dev/i18n";
import { editorCatalogues } from "../src/i18n/catalogues";
import { takePairInvitation } from "./invitation";
import { cleanDirectEntry } from "./trust";
import "./style.css";

const root = createRoot(document.getElementById("root")!);
const lifetime = new AbortController();

async function launch() {
  let invitation: string | undefined;
  let invalid = false;
  try { invitation = takePairInvitation(); } catch { invalid = true; }
  await createI18nRuntime({ ...editorCatalogues, i18n }).initialize();
  document.title = t`Connect to your own server`;
  function render(content: ReactNode) {
    root.render(<I18nProvider i18n={i18n}>{content}
      <footer>{t`Most people use mdbase editor with their mdbase account.`}{" "}
        <a href="https://editor.mdbase.dev/" referrerPolicy="no-referrer">{t`Return to mdbase editor`}</a></footer>
    </I18nProvider>);
  }
  function block() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    render(<p role="alert" tabIndex={-1} ref={node => node?.focus()}>{t`Open this editor at its dedicated HTTPS address, without a query, fragment or service worker.`}</p>);
  }
  async function allowed() {
    if (!await cleanDirectEntry(import.meta.env.MDBASE_EDITOR_DIRECT_ORIGIN)) block();
    return !lifetime.signal.aborted;
  }
  if (!await allowed()) return;
  navigator.serviceWorker?.addEventListener("controllerchange", block, { signal: lifetime.signal });
  const { DirectEditor } = await import("./DirectEditor");
  if (await allowed()) render(<DirectEditor invitation={invitation} invalidInvitation={invalid} allowed={allowed} signal={lifetime.signal} />);
}

window.addEventListener("pagehide", () => { lifetime.abort(); root.unmount(); }, { once: true });
window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
if (import.meta.env.PROD && import.meta.env.MDBASE_EDITOR_DIRECT_BUILD) void launch();
