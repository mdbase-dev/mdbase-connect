import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultOrigin = "https://editor.mdbase.dev";
const defaultBasePath = "/";
const origin = (process.env.MDBASE_EDITOR_ORIGIN ?? defaultOrigin).replace(/\/$/, "");
const basePath = normalizeBasePath(process.env.MDBASE_EDITOR_BASE_PATH ?? defaultBasePath);
const appUrl = new URL(basePath, `${origin}/`).href;
const connectUrl = process.env.MDBASE_CONNECT_URL?.trim();
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
  requirements: {
    contracts: [],
    capabilities: {
      contract_version: 2,
      required: [
        "collection.read",
        "records.create",
        "records.edit",
        "records.delete",
        "definitions.manage",
      ],
    },
    files: {
      required: ["list", "read"],
      optional: ["add"],
      scope: { kind: "collection" }
    },
    access: "full_collection"
  }
}, null, 2)}\n`);

function normalizeBasePath(value) {
  return `/${value.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
}
