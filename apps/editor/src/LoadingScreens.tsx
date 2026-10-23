import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { OpeningScreen as SharedOpeningScreen } from "@mdbase-dev/ui/screens";

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
  return <SharedOpeningScreen app="editor" title={t`Opening collection`} detail={t`Reading its notes and types`} entrance="flock" />;
}
