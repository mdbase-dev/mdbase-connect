import { t } from "@lingui/core/macro";
import "./i18n.js";
/**
 * The mdbase apps a collection can be opened in. Editor is the canonical app for a
 * collection; Reader and Writer serve particular workflows on the same records.
 */
export type MdbaseAppId = "editor" | "reader" | "writer";

export interface MdbaseApp {
  readonly id: MdbaseAppId;
  readonly name: string;
  readonly description: string;
  /** Deployment URL supplied by the consumer with `withAppUrls`. */
  readonly url: string;
}

export const mdbaseApps: readonly MdbaseApp[] = [
  {
    id: "editor",
    name: "Editor",
    get description() { return t({ message: "Browse and edit records" }); },
    url: ""
  },
  {
    id: "reader",
    name: "Reader",
    get description() { return t({ message: "Read and annotate sources" }); },
    url: ""
  },
  {
    id: "writer",
    name: "Writer",
    get description() { return t({ message: "Write manuscripts that cite your sources" }); },
    url: ""
  }
];

/** Every app mdbase makes: the family above plus apps with their own identity. */
export interface OfficialApp extends Omit<MdbaseApp, "id"> {
  readonly id: MdbaseAppId | "journal" | "tasknotes";
}

export const officialApps: readonly OfficialApp[] = [
  ...mdbaseApps,
  {
    id: "journal",
    name: "Journal",
    get description() { return t({ message: "Keep a daily journal" }); },
    url: ""
  },
  {
    id: "tasknotes",
    name: "TaskNotes",
    get description() { return t({ message: "Plan tasks and projects" }); },
    url: ""
  }
];

/**
 * Replaces app URLs for a lab or local build, for example from
 * `import.meta.env.VITE_MDBASE_WRITER_URL`. Apps without a URL are omitted.
 */
export function withAppUrls<App extends OfficialApp = MdbaseApp>(
  urls: Partial<Record<App["id"], string | undefined>>,
  apps: readonly App[] = mdbaseApps as readonly OfficialApp[] as readonly App[]
): readonly App[] {
  return apps.map((app) => {
    const url = urls[app.id as App["id"]];
    return url ? { ...app, url } : app;
  }).filter((app) => app.url);
}

/**
 * Parameters every mdbase app reads the same way: `collection` is the Connect SDK's
 * selection and `server` picks a non-default Connect server. App-specific parameters
 * (Reader's `source`, Writer's `manuscript`) mean nothing to another app, so they stay behind.
 */
const sharedParameters = ["collection", "server"] as const;

/** A link that opens the current page's collection in another app. */
export function mdbaseAppHref(appUrl: string, currentHref: string): string {
  const target = new URL(appUrl);
  const current = new URL(currentHref);
  for (const key of sharedParameters) {
    const value = current.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return target.href;
}
