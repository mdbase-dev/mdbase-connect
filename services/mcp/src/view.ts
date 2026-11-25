import { readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { gzipSync } from "node:zlib";

/** Where the gateway serves the view's built files. */
export const VIEW_ASSET_PATH = "/view/assets/";

export interface ViewAsset {
  readonly type: string;
  readonly body: Buffer;
  /** The body gzipped once at startup: the gateway has no response compression of its own. */
  readonly gzip: Buffer;
}

/** The built MCP App view (`pnpm build:view`): its page, and the hashed files the page loads. */
export interface ViewBuild {
  readonly page: string;
  readonly assets: ReadonlyMap<string, ViewAsset>;
}

const TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml"
};

/** Reads the view build; a missing build or a file of an unexpected kind fails startup. */
export function readViewBuild(directory: URL): ViewBuild {
  const assets = new Map(readdirSync(new URL("assets/", directory)).map((name) => {
    const type = TYPES[extname(name)];
    if (!type) throw new Error(`The view build has an unexpected file: ${name}.`);
    const body = readFileSync(new URL(`assets/${name}`, directory));
    return [name, { type, body, gzip: gzipSync(body, { level: 9 }) }] as const;
  }));
  return { page: readFileSync(new URL("index.html", directory), "utf8"), assets };
}

/**
 * The page as hosts receive it. Hosts render it without a base URL, so its references to the
 * built files name this gateway; every reference must be one of them.
 */
export function viewPage(build: ViewBuild, publicUrl: string): string {
  const page = build.page.replace(/(src|href)="\.\/assets\/([^"]+)"/gu, (_match, attribute: string, name: string) => {
    if (!build.assets.has(name)) throw new Error(`The view page names a file the build does not have: ${name}.`);
    return `${attribute}="${publicUrl}${VIEW_ASSET_PATH}${name}"`;
  });
  if (/(?:src|href)="\.\//u.test(page)) throw new Error("The view page names a file outside its assets.");
  return page;
}
