import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
import { AppTile, appsByCollection, homeApps, officialAppsAt, type LaunchableApp } from "@mdbase/connect-ui/home";
import type { ManagementOverview } from "@mdbase/connect-management";
import type { applicationGroups } from "./ApplicationAccess";
import { ConnectEmpty as Empty, ConnectPage as Page, ConnectSectionTitle as SectionTitle, RouteLink, type ConnectView } from "./ConnectPrimitives";

type ApplicationGroup = ReturnType<typeof applicationGroups>[number];

/**
 * The overview's grants and installations, in the shape of the desktop's
 * account listing: one entry per app, opened from its homepage (an
 * installation's origin when it has no grant), with each collection once.
 */
function approvedApps(groups: readonly ApplicationGroup[]) {
  return groups.map((group) => {
    const grant = group.grants[0];
    const collections = new Map<string, string>();
    for (const entry of group.grants) collections.set(entry.collection_id, entry.collection_name);
    for (const entry of group.installations) if (entry.collection_id && entry.available && entry.collection_name) collections.set(entry.collection_id, entry.collection_name);
    return {
      id: group.applicationId,
      name: group.applicationName,
      distribution: grant?.distribution ?? "web" as const,
      homepage: grant?.homepage ?? group.installations[0]?.application_origin ?? null,
      icon: grant?.icon ?? group.installations[0]?.icon ?? null,
      collections: [...collections].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
    };
  });
}

export function HomePage({ data, collections, applications, origins, navigate }: {
  data: Pick<ManagementOverview, "pending_authorizations">;
  collections: ReadonlyArray<{ id: string; name: string; status: string; detail: string }>;
  applications: readonly ApplicationGroup[];
  origins: Parameters<typeof officialAppsAt>[0];
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  useLocaleRevision();
  const approved = approvedApps(applications);
  const { yours, suggested } = homeApps(approved, officialAppsAt(origins), data.pending_authorizations.map((request) => request.application_name));
  const usedBy = appsByCollection(approved);
  const listFormat = new Intl.ListFormat(i18n.locale, { type: "conjunction" });
  return <Page title={t(i18n)({ message: "Home", context: "Connect interface" })}>
    {(yours.length > 0 || suggested.length === 0) && <section aria-labelledby="home-apps">
      <SectionTitle id="home-apps" title={t(i18n)`Your apps`} />
      {yours.length > 0
        ? <ul className="app-grid">{yours.map((app) => <OpenTile key={app.key} app={app} />)}</ul>
        : <p className="home-note"><Trans>Apps you approve appear here.</Trans></p>}
    </section>}
    {suggested.length > 0 && <section aria-labelledby="home-more">
      <SectionTitle id="home-more" title={yours.length > 0 ? t(i18n)`More apps from mdbase` : t(i18n)`Start with an app`} />
      <ul className="app-grid">{suggested.map((app) => <OpenTile key={app.key} app={app} />)}</ul>
      <p className="home-note"><Trans>An app asks for access to a collection the first time you use it, and you choose what it can do.</Trans></p>
    </section>}
    <section aria-labelledby="home-collections">
      <SectionTitle id="home-collections" title={t(i18n)({ message: "Collections", context: "Connect interface" })} />
      {collections.length === 0
        ? <Empty title={t(i18n)({ message: "Add your first collection" })} body={t(i18n)`Choose where your first collection lives.`} action={<RouteLink className="mdbase-button is-primary" view="collections" navigate={navigate}><Trans>Add collection</Trans></RouteLink>} />
        : <ul className="home-collections">{collections.map((collection) => {
          const apps = usedBy.get(collection.id) ?? [];
          return <li key={collection.id}>
            <RouteLink view="overview" collectionId={collection.id} navigate={navigate}>
              <strong>{collection.name}</strong>
              <span>{[collection.status, collection.detail].filter(Boolean).join(" · ")}</span>
              <small>{apps.length > 0 ? listFormat.format(apps) : t(i18n)`No apps yet`}</small>
            </RouteLink>
          </li>;
        })}</ul>}
    </section>
  </Page>;
}

/** Apps open in a tab of their own; the portal never hands them its session. */
function OpenTile({ app }: { app: LaunchableApp }) {
  useLocaleRevision();
  return <AppTile app={app}>
    {app.url && <a className="mdbase-button" href={app.url} target="_blank" rel="noopener noreferrer" aria-label={t(i18n)`Open ${app.name}`}><Trans>Open</Trans></a>}
  </AppTile>;
}
