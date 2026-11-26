/** What Home shows, on the desktop and on the web: the apps approved in this account, and the official apps not yet used. */
import { t } from "@lingui/core/macro";
import { officialApps, withAppUrls, type OfficialApp } from "@mdbase-dev/ui/apps";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

export const MCP_ENDPOINT_URL = "https://mcp.mdbase.dev/mcp";
// Direct Claude and ChatGPT plugin directory URLs can be added alongside MCP_SETUP_URL once published.
export const MCP_SETUP_URL = "https://mdbase.dev/apps/mcp/";

const MCP_ORIGIN = new URL(MCP_ENDPOINT_URL).origin;

export interface LaunchableApp {
  key: string;
  name: string;
  /** Opens the app; null when it has no web address (a portable app) or an unusable one. */
  url: string | null;
  description?: string;
  /** The official app this is, which draws its bundled mark. */
  official?: string;
  /** The manifest's icon, on the app's own HTTPS origin. */
  icon: string | null;
  collections: Array<{ id: string; name: string }>;
}

interface OfficialAppLike {
  id: string;
  name: string;
  url: string;
  description: string;
}

/** An app approved in the account, as the server's account application listing reports it. */
interface ApprovedAppLike {
  id: string;
  name: string;
  distribution: "web" | "portable";
  homepage: string | null;
  icon: string | null;
  collections: Array<{ id: string; name: string }>;
}

/** One managed environment's app origins, as `scripts/lib/managed-app-origins.mjs` lists them. */
export interface ManagedAppOrigins {
  editorOrigin: string;
  readerOrigin: string;
  writerOrigin: string;
  journalOrigin: string;
  tasknotesOrigin: string;
}

/** Appends `?collection=<collectionId>` cleanly to an app URL. */
export function collectionAppUrl(appUrl: string, collectionId: string): string {
  const url = new URL(appUrl);
  url.searchParams.set("collection", collectionId);
  return url.href;
}

export interface CollectionAppMatch {
  name?: string | null;
  origin?: string | null;
}

/** Whether an application identity refers to mdbase MCP. */
export function isMcpApp(app: CollectionAppMatch): boolean {
  const origin = webOrigin(app.origin ?? null);
  if (origin) {
    if (origin === MCP_ORIGIN) return true;
    if (/^mcp(?:-[a-z0-9-]+)?\.mdbase\.dev$/i.test(new URL(origin).hostname)) return true;
  }
  const name = app.name?.trim().toLocaleLowerCase() ?? "";
  return name === "mcp" || name === "mdbase mcp" || name === "dev.mdbase.mcp" || /\bmcp\b/.test(name);
}

function matchesOfficialApp(entry: CollectionAppMatch, official: OfficialAppLike): boolean {
  const entryOrigin = webOrigin(entry.origin ?? null);
  const officialOrigin = webOrigin(official.url);
  if (entryOrigin && officialOrigin) return entryOrigin === officialOrigin;
  const entryName = entry.name?.trim().toLocaleLowerCase();
  return Boolean(entryName && entryName === official.name.toLocaleLowerCase());
}

/**
 * Official mdbase apps not yet approved for a collection, with each URL scoped
 * to that collection, plus whether AI clients (MCP) should still be offered.
 */
export function collectionDiscoveryApps(
  origins: ManagedAppOrigins | undefined,
  collectionId: string,
  existing: readonly CollectionAppMatch[]
): { apps: LaunchableApp[]; showMcp: boolean } {
  const official = officialAppsAt(origins);
  if (official.length === 0) return { apps: [], showMcp: false };
  const apps: LaunchableApp[] = official
    .filter(app => webOrigin(app.url) && !existing.some(entry => matchesOfficialApp(entry, app)))
    .map(app => ({
      key: app.id,
      name: app.name,
      url: collectionAppUrl(app.url, collectionId),
      description: app.description,
      official: app.id,
      icon: null,
      collections: []
    }));
  return { apps, showMcp: !existing.some(isMcpApp) };
}

/** The official apps of a managed environment; none for an unknown or custom server. */
export function officialAppsAt(origins: ManagedAppOrigins | undefined): readonly OfficialApp[] {
  if (!origins) return [];
  return withAppUrls({
    editor: origins.editorOrigin,
    reader: origins.readerOrigin,
    writer: origins.writerOrigin,
    journal: origins.journalOrigin,
    tasknotes: origins.tasknotesOrigin
  }, officialApps);
}

function webOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Approved apps keep the server's order. An official app is suggested until an
 * approved app has its origin, or while a request from it waits for approval.
 */
export function homeApps(approved: readonly ApprovedAppLike[], official: readonly OfficialAppLike[], pendingNames: readonly string[]) {
  const officialByOrigin = new Map(official.map(app => [webOrigin(app.url), app]));
  const yours: LaunchableApp[] = approved.map(app => {
    const origin = app.distribution === "web" ? webOrigin(app.homepage) : null;
    const official = origin ? officialByOrigin.get(origin) : undefined;
    return {
      key: app.id,
      name: app.name,
      url: origin ? app.homepage : null,
      description: official?.description,
      official: official?.id,
      icon: origin && webOrigin(app.icon) === origin ? app.icon : null,
      collections: app.collections
    };
  });
  const used = new Set(yours.map(app => app.url && webOrigin(app.url)));
  const pending = new Set(pendingNames.map(name => name.toLocaleLowerCase()));
  const suggested: LaunchableApp[] = official
    .filter(app => webOrigin(app.url) && !used.has(webOrigin(app.url)) && !pending.has(app.name.toLocaleLowerCase()))
    .map(app => ({ key: app.id, name: app.name, url: app.url, description: app.description, official: app.id, icon: null, collections: [] }));
  return { yours, suggested };
}

/** The names of the approved apps that use each collection, keyed by collection ID. */
export function appsByCollection(approved: readonly ApprovedAppLike[]): Map<string, string[]> {
  const byCollection = new Map<string, string[]>();
  for (const app of approved) {
    for (const collection of app.collections) {
      byCollection.set(collection.id, [...byCollection.get(collection.id) ?? [], app.name]);
    }
  }
  return byCollection;
}

/** A stable tone (0-4) and initial for an app's letter mark. */
export function letterMark(name: string): { letter: string; tone: number } {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return { letter: [...name.trim()][0]?.toLocaleUpperCase() ?? "?", tone: hash % 5 };
}

/** One app on Home: its mark, its collections (or what it does) and the caller's way to open it. */
export function AppTile({ app, children }: { app: LaunchableApp; children?: ReactNode }): JSX.Element {
  useLocaleRevision();
  const [iconFailed, setIconFailed] = useState(false);
  const mark = letterMark(app.name);
  const detail = app.collections.length > 0
    ? new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(app.collections.map(collection => collection.name))
    : app.description;
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
      {children}
    </li>
  );
}

/** Quiet row for connecting Claude, ChatGPT, and Codex via mdbase plugins and MCP on managed environments. */
export function McpConnectRow({ onOpenSetup }: { onOpenSetup?: (url: string) => void } = {}): JSX.Element {
  useLocaleRevision();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copyEndpoint() {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(MCP_ENDPOINT_URL);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mcp-connect-row">
      <div className="mcp-connect-copy">
        <strong>{t(i18n)({ message: "Claude, ChatGPT & Codex", context: "AI clients" })}</strong>
        <small>{t(i18n)({ message: "AI clients via mdbase plugins & MCP", context: "AI clients" })}</small>
        <code className="mcp-connect-endpoint">{MCP_ENDPOINT_URL}</code>
      </div>
      <div className="mcp-connect-actions">
        <button type="button" className="mdbase-button" onClick={() => void copyEndpoint()}>
          {copied ? t(i18n)({ message: "Copied", context: "AI clients" }) : t(i18n)({ message: "Copy", context: "AI clients" })}
        </button>
        <a
          className="mdbase-button is-tertiary"
          href={MCP_SETUP_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onOpenSetup ? (event) => { event.preventDefault(); onOpenSetup(MCP_SETUP_URL); } : undefined}
        >
          {t(i18n)({ message: "Set up", context: "AI clients" })}
        </a>
      </div>
    </div>
  );
}
