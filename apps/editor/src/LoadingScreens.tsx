import { OpeningScreen as SharedOpeningScreen } from "@mdbase-dev/ui/screens";

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
  return <SharedOpeningScreen app="editor" title="Opening collection" detail="Reading its notes and types" />;
}
