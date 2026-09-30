/**
 * The mdbase apps a collection can be opened in. Editor is the canonical app for a
 * collection; Reader and Writer serve particular workflows on the same records.
 */
export type MdbaseAppId = "editor" | "reader" | "writer";

export interface MdbaseApp {
  readonly id: MdbaseAppId;
  readonly name: string;
  readonly description: string;
  /** Production origin. Lab and local builds substitute their own with `withAppUrls`. */
  readonly url: string;
  /** The main app for a collection: it carries the platform mark and leads the app menu. */
  readonly main?: boolean | undefined;
}

export const mdbaseApps: readonly MdbaseApp[] = [
  {
    id: "editor",
    name: "Editor",
    description: "Browse and edit records",
    url: "https://editor.mdbase.dev/",
    main: true
  },
  {
    id: "reader",
    name: "Reader",
    description: "Read and annotate sources",
    url: "https://reader.mdbase.dev/"
  },
  {
    id: "writer",
    name: "Writer",
    description: "Write manuscripts that cite your sources",
    url: "https://writer.mdbase.dev/"
  }
];

/**
 * Replaces app URLs for a lab or local build, for example from
 * `import.meta.env.VITE_MDBASE_WRITER_URL`. Unset entries keep production.
 */
export function withAppUrls(
  urls: Partial<Record<MdbaseAppId, string | undefined>>,
  apps: readonly MdbaseApp[] = mdbaseApps
): readonly MdbaseApp[] {
  return apps.map((app) => {
    const url = urls[app.id];
    return url ? { ...app, url } : app;
  });
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
