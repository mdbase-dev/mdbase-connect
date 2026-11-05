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
  return <div className="app-shell editor-opening surface-notes pane-notes" role="main" aria-label={t`Opening collection`} aria-busy="true" data-loading-state="opening">
    <aside className="collection-rail"><Wordmark app="editor" /><p><Trans>Opening collection</Trans></p></aside>
    <section className="note-list-pane"><header className="list-header"><div><h1><Trans>Opening collection</Trans></h1><p role="status"><Trans>Reading its notes and types</Trans></p></div></header><div className="note-list-controls"><div className="search-field"><input aria-label={t`Search notes and files`} placeholder={t`Search`} disabled /></div></div><div className="note-selection-slot" /><div className="opening-list-skeleton" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div></section>
    <div className="editor-pane" />
  </div>;
}
