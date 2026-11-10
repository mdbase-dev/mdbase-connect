import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { officialApps, withAppUrls } from "@mdbase-dev/ui/apps";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
import React, { useEffect, useMemo, useState } from "react";
import { managedAppOrigins } from "../../../../scripts/lib/managed-app-origins.mjs";
import { presentCollection } from "./daemon-view.mjs";
import { appsByCollection, homeApps, letterMark, type LaunchableApp } from "./home-model.mjs";
import { Empty } from "./ui-components";
import { message, type Route } from "./view-model";

const APPS_POLL_MS = 60_000;

const listFormat = (names: string[]) => new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(names);

/** The official apps of the environment this computer is signed in to; none for a custom server. */
function officialFor(environment: string | undefined) {
  const origins = managedAppOrigins[environment as keyof typeof managedAppOrigins];
  if (!origins) return [];
  return withAppUrls({
    editor: origins.editorOrigin,
    reader: origins.readerOrigin,
    writer: origins.writerOrigin,
    journal: origins.journalOrigin,
    tasknotes: origins.tasknotesOrigin
  }, officialApps);
}

export function HomeView({ environment, collections, pendingApps, busy, onNavigate, onReview, onAdd, onCreate, onAct }: {
  environment: string | undefined;
  collections: DaemonCollection[];
  pendingApps: string[];
  busy: boolean;
  onNavigate(route: Route): void;
  onReview(): void;
  onAdd(): void;
  onCreate(): void;
  onAct(action: () => Promise<unknown>): Promise<void>;
}) {
  useLocaleRevision();
  const [approved, setApproved] = useState<AccountApplication[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = () => window.mdbaseConnect.listApps().then(
      (result) => { if (current) { setApproved(result.applications); setFailure(null); } },
      (reason) => { if (current) setFailure(message(reason)); }
    );
    void load();
    const timer = window.setInterval(load, APPS_POLL_MS);
    return () => { current = false; window.clearInterval(timer); };
  }, []);

  const { yours, suggested } = useMemo(
    () => homeApps(approved ?? [], officialFor(environment), pendingApps),
    [approved, environment, pendingApps]
  );
  const usedBy = useMemo(() => appsByCollection(approved ?? []), [approved]);
  const open = (url: string) => void onAct(() => window.mdbaseConnect.openApp(url));

  return (
    <div className="workspace-stack home">
      {pendingApps.length > 0 && <div className="mdbase-message home-pending" role="status">
        <span>{t(i18n)`${plural(pendingApps.length, { one: "# app is waiting for your approval.", other: "# apps are waiting for your approval." })}`}</span>
        <button className="mdbase-button" onClick={onReview}><Trans>Review</Trans></button>
      </div>}

      {(yours.length > 0 || failure || (approved && suggested.length === 0)) && <section aria-labelledby="home-apps">
        <h2 id="home-apps" className="home-heading">{t(i18n)`Your apps`}</h2>
        {failure && <div className="mdbase-message is-error" role="alert">{t(i18n)`Your apps could not be listed. ${failure}`}</div>}
        {yours.length > 0
          ? <ul className="app-grid">{yours.map(app => <AppTile key={app.key} app={app} busy={busy} onOpen={open} />)}</ul>
          : !failure && <p className="home-note">{t(i18n)`Apps you approve appear here.`}</p>}
      </section>}

      {suggested.length > 0 && <section aria-labelledby="home-more">
        <h2 id="home-more" className="home-heading">{yours.length > 0 ? t(i18n)`More apps from mdbase` : t(i18n)`Start with an app`}</h2>
        <ul className="app-grid">{suggested.map(app => <AppTile key={app.key} app={app} busy={busy} onOpen={open} />)}</ul>
        <p className="home-note">{t(i18n)`An app asks for access to a collection the first time you use it, and you choose what it can do.`}</p>
      </section>}

      <section aria-labelledby="home-collections">
        <div className="home-heading-row">
          <h2 id="home-collections" className="home-heading"><Trans context="Connect interface">Collections</Trans></h2>
          {collections.length > 0 && <button className="mdbase-button is-tertiary" disabled={busy} onClick={onAdd}><Trans>Add existing folder</Trans></button>}
        </div>
        {collections.length === 0 ? <>
          <Empty title={t(i18n)({ message: "Add your first collection" })} text={t(i18n)({ message: "Choose a folder of Markdown notes, or create a new one. It stays on this computer; your apps reach it through mdbase." })} />
          <div className="collection-config-actions">
            <button className="mdbase-button is-primary" disabled={busy} onClick={onAdd}><Trans>Add existing folder</Trans></button>
            <button className="mdbase-button" disabled={busy} onClick={onCreate}><Trans>Create collection</Trans></button>
          </div>
        </> : <ul className="home-collections">
          {collections.map(collection => {
            const view = presentCollection(collection);
            const apps = usedBy.get(collection.id) ?? [];
            return <li key={collection.id}>
              <a href="#collections" onClick={(event) => { event.preventDefault(); onNavigate("collections"); }}>
                <strong>{collection.name}</strong>
                <span>{view.status} · {view.mode}</span>
                <small>{apps.length > 0 ? listFormat(apps) : t(i18n)`No apps yet`}</small>
              </a>
            </li>;
          })}
        </ul>}
      </section>

      {(yours.some(app => app.url) || suggested.length > 0) &&
        <p className="home-note">{t(i18n)`Apps open in a window of their own in your default browser.`}</p>}
    </div>
  );
}

function AppTile({ app, busy, onOpen }: { app: LaunchableApp; busy: boolean; onOpen(url: string): void }) {
  useLocaleRevision();
  const [iconFailed, setIconFailed] = useState(false);
  const mark = letterMark(app.name);
  const detail = app.collections.length > 0 ? listFormat(app.collections.map(collection => collection.name)) : app.description;
  return (
    <li className="app-tile">
      {app.official === "editor" || app.official === "reader" || app.official === "writer"
        ? <span className="app-mark is-bundled" aria-hidden="true"><MdbaseMark app={app.official === "editor" ? undefined : app.official} /></span>
        : app.icon && !iconFailed
          ? <img className="app-mark is-icon" src={app.icon} alt="" referrerPolicy="no-referrer" onError={() => setIconFailed(true)} />
          : <span className="app-mark" data-tone={mark.tone} aria-hidden="true">{mark.letter}</span>}
      <span className="app-tile-text">
        <strong>{app.name}</strong>
        {detail && <small>{detail}</small>}
      </span>
      {app.url
        ? <button className="mdbase-button" disabled={busy} aria-label={t(i18n)`Open ${app.name}`} onClick={() => onOpen(app.url!)}><Trans>Open</Trans></button>
        : null}
    </li>
  );
}
