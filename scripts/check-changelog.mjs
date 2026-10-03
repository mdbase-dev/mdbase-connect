import { readFile } from "node:fs/promises";
import { fragments, assembleChangelog } from "./lib/changelog.mjs";

const entries = await fragments(process.cwd());
// Validate the managed section even when there are no pending release notes.
assembleChangelog(await readFile("CHANGELOG.md", "utf8"), entries.length ? entries : [
  { section: "Changed", body: "- Format check." }
], "format-check");
console.log(`Changelog check passed: ${entries.length} fragments.`);
