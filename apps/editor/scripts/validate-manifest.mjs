import { readFile } from "node:fs/promises";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";

// The devkit's current-only validator intentionally targets v2. Bridge releases
// validate the actual declaration through the version-dispatched protocol parser.
const source = new URL("../public/.well-known/mdbase-app.json", import.meta.url);
const parsed = parseVersionedAppManifest(JSON.parse(await readFile(source, "utf8")));
if (parsed.contractVersion !== 1) throw new Error("Editor bridge releases must declare semantic v1");
console.log("Editor bridge manifest valid (semantic v1)");
