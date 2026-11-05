import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Wordmark } from "@mdbase-dev/ui/brand";

export function TypeWorkspaceLoading() {
  useLingui();
  return <>
    <section className="type-list-pane type-workspace-loading" aria-label={t`Loading types`} aria-busy="true">
      <strong><Trans>Types</Trans></strong><p role="status"><Trans>Preparing type list…</Trans></p>
    </section>
    <main className="type-inspector type-workspace-loading" aria-label={t`Loading type definition`} aria-busy="true">
      <p role="status"><Trans>Preparing type workspace…</Trans></p>
    </main>
  </>;
}
export function OpeningScreen() {
  useLingui();
  return <div className="app-shell editor-opening" role="main" aria-label={t`Opening collection`} aria-busy="true" data-loading-state="opening">
    <aside className="collection-rail"><Wordmark app="editor" /><p><Trans>Opening collection</Trans></p></aside>
    <section className="note-list-pane"><p role="status"><Trans>Reading its notes and types</Trans></p></section>
    <div className="editor-pane" />
  </div>;
}
