import { readFile } from "node:fs/promises";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";

// New Editor artifacts must explicitly declare semantic v2.
const source = new URL("../public/.well-known/mdbase-app.json", import.meta.url);
const parsed = parseVersionedAppManifest(JSON.parse(await readFile(source, "utf8")));
if (parsed.contractVersion !== 2) throw new Error("New Editor releases must declare semantic v2");
console.log("Editor manifest valid (semantic v2)");
