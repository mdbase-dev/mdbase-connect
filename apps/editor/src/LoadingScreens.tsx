import { Wordmark } from "./Brand";

export function TypeWorkspaceLoading() {
  return <>
    <section className="type-list-pane type-workspace-loading" aria-label="Loading types" aria-busy="true">
      <strong>Types</strong><p role="status">Preparing type list…</p>
    </section>
    <main className="type-inspector type-workspace-loading" aria-label="Loading type definition" aria-busy="true">
      <p role="status">Preparing type workspace…</p>
    </main>
  </>;
}
export function OpeningScreen() {
  return <main className="opening-shell" data-loading-state="opening" aria-label="Opening collection" aria-busy="true">
    <div className="opening-message" role="status">
      <Wordmark />
      <div><p>Opening collection</p><small>Reading its notes and types</small></div>
    </div>
  </main>;
}
