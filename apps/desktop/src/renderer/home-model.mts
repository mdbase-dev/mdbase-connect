/** What Home shows: the apps approved in this account, and the official apps not yet used. */

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

interface ApprovedAppLike {
  id: string;
  name: string;
  distribution: "web" | "portable";
  homepage: string | null;
  icon: string | null;
  collections: Array<{ id: string; name: string }>;
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
