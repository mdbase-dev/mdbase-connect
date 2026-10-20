import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultOrigin = "https://editor.mdbase.dev";
const defaultBasePath = "/";
const origin = (process.env.MDBASE_EDITOR_ORIGIN ?? defaultOrigin).replace(/\/$/, "");
const basePath = normalizeBasePath(process.env.MDBASE_EDITOR_BASE_PATH ?? defaultBasePath);
const appUrl = new URL(basePath, `${origin}/`).href;
const connectUrl = process.env.MDBASE_CONNECT_URL?.trim();
const labOrigin = process.env.MDBASE_EDITOR_LAB_ORIGIN;
const environment = process.env.MDBASE_ENV ?? process.env.VITE_MDBASE_ENV;
if ((environment !== undefined && !["lab", "staging", "production"].includes(environment))
  || (process.env.MDBASE_ENV !== undefined && process.env.VITE_MDBASE_ENV !== undefined
    && process.env.MDBASE_ENV !== process.env.VITE_MDBASE_ENV)) {
  throw new Error("Invalid or mismatched Editor application environment");
}
let installationOrigins;
if (environment === "staging" || environment === "production") {
  const expectedOrigin = environment === "staging" ? "https://editor-staging.mdbase.dev" : defaultOrigin;
  const expectedConnect = environment === "staging" ? "https://connect-staging.mdbase.dev" : "https://connect.mdbase.dev";
  if (origin !== expectedOrigin || (connectUrl && connectUrl !== expectedConnect)) {
    throw new Error("Editor application/Connect origin differs from its native environment");
  }
  installationOrigins = { [environment]: { "app-runtime": [origin] } };
}
if (labOrigin !== undefined) {
  const url = new URL(labOrigin);
  if (process.env.MDBASE_ENV !== "lab" || url.origin !== labOrigin
    || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Editor LAB installation origin must be an exact loopback HTTP origin in LAB");
  }
  if (new URL(appUrl).protocol !== "https:") {
    throw new Error("Editor LAB declaration must retain an HTTPS homepage");
  }
  installationOrigins = { lab: { "app-runtime": [labOrigin] } };
}
const localCallback = connectUrl ? new URL(appUrl) : null;
if (localCallback) {
  localCallback.searchParams.set("server", new URL(connectUrl).origin);
}
const target = resolve(import.meta.dirname, "..", "public", ".well-known", "mdbase-app.json");

await mkdir(resolve(target, ".."), { recursive: true });
await writeFile(target, `${JSON.stringify({
  manifest_version: 1,
  id: "dev.mdbase.editor",
  name: "mdbase editor",
  homepage: appUrl,
  redirect_uris: [appUrl, ...(localCallback ? [localCallback.href] : [])],
  ...(installationOrigins ? { installation_origins: installationOrigins } : {}),
  requirements: {
    people: { version: 1, optional: ["identity"] },
    contracts: [],
    capabilities: {
      contract_version: 2,
      required: ["collection.read"],
      optional: [
        "records.create",
        "records.edit",
        "records.delete",
        "definitions.manage"
      ]
    },
    // Next accounts approve each record capability together with its file
    // actions, so each optional record capability declares its pair.
    files: {
      required: ["list", "read"],
      optional: ["add", "replace", "move", "delete"],
      scope: { kind: "collection" }
    },
    access: "full_collection"
  }
}, null, 2)}\n`);

function normalizeBasePath(value) {
  return `/${value.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
}
