import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const defaultOrigin = "https://editor.mdbase.dev";
const defaultBasePath = "/";
const origin = (process.env.MDBASE_EDITOR_ORIGIN ?? defaultOrigin).replace(/\/$/, "");
const basePath = normalizeBasePath(process.env.MDBASE_EDITOR_BASE_PATH ?? defaultBasePath);
const appUrl = new URL(basePath, `${origin}/`).href;
const target = resolve(import.meta.dirname, "..", "public", ".well-known", "mdbase-app.json");

await mkdir(resolve(target, ".."), { recursive: true });
await writeFile(target, `${JSON.stringify({
  manifest_version: 1,
  id: "dev.mdbase.editor",
  name: "mdbase editor",
  homepage: appUrl,
  redirect_uris: [appUrl],
  requirements: {
    contracts: [],
    capabilities: {
      contract_version: 1,
      required: [
        "collection.inspect",
        "records.watch",
        "records.read",
        "records.query",
        "records.validate",
        "records.create",
        "records.update",
        "records.delete",
        "records.rename",
        "files.list",
        "files.read",
        "definitions.read",
        "definitions.create",
        "definitions.update",
        "definitions.type-pack.apply",
      ],
      optional: ["files.add"],
    },
    files: {
      actions: ["list", "read", "add"],
      scope: { kind: "collection" }
    },
    access: "full_collection"
  }
}, null, 2)}\n`);

function normalizeBasePath(value) {
  return `/${value.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
}
