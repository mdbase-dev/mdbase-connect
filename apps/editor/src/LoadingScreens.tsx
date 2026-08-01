import { Wordmark } from "./Brand";

export function TypeWorkspaceLoading() {
  return <>
    <section className="type-list-pane type-workspace-loading" aria-label="Loading types"><div /><span /><span /><span /></section>
    <main className="type-inspector type-workspace-loading" aria-label="Loading type definition"><div /><strong /><span /><span /></main>
  </>;
}
export function OpeningScreen() {
  return <main className="opening-shell" aria-label="Opening collection" aria-busy="true">
    <aside className="opening-rail"><Wordmark /><div className="opening-rail-lines"><span /><span /><span /></div></aside>
    <section className="opening-list" aria-hidden="true"><div className="opening-list-heading"><span /><small /></div><div className="opening-search" />{Array.from({ length: 7 }, (_, index) => <div className="opening-row" key={index}><span /><small /></div>)}</section>
    <section className="opening-document">
      <div className="opening-document-bar" aria-hidden="true"><span /></div>
      <div className="opening-message"><span className="opening-pulse" aria-hidden="true" /><div><p>Opening collection</p><small>Reading its notes and types</small></div></div>
      <div className="opening-document-lines" aria-hidden="true"><strong /><span /><span /><span /></div>
    </section>
  </main>;
}
