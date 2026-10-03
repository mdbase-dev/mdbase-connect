import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const sections = ["Breaking", "Added", "Changed", "Fixed", "Removed", "Security"];

export function parseFragment(name, text) {
  if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(name)) throw new Error(`Invalid changelog fragment filename: ${name}`);
  const match = /^## ([^\n]+)\n\n(- [\s\S]+?)\s*$/.exec(text);
  if (!match || !sections.includes(match[1]) || /^#{1,6} /m.test(match[2]) ||
      match[2].split("\n").some((line) => (line.startsWith("- ") && !line.slice(2).trim()) ||
        (line && !line.startsWith("- ") && !line.startsWith("  ")))) {
    throw new Error(`${name}: expected one '## Section' (with a supported section) and Markdown bullets with indented continuations.`);
  }
  return { name, section: match[1], body: match[2] };
}

export async function fragments(root) {
  const directory = path.join(root, "changelog.d");
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return Promise.all(names.sort().map(async (name) => parseFragment(name, await readFile(path.join(directory, name), "utf8"))));
}

export function assembleChangelog(changelog, entries, version) {
  const marker = "## Unreleased\n\n<!-- Add release notes in changelog.d; assembled by pnpm version:set. -->";
  if (!changelog.startsWith(`# Changelog\n\n${marker}\n`) || (changelog.match(/^## Unreleased$/gm) ?? []).length !== 1) {
    throw new Error("CHANGELOG.md must have exactly one empty, fragment-managed Unreleased section.");
  }
  const history = changelog.slice(`# Changelog\n\n${marker}`.length).trimStart();
  if (history && !history.startsWith("## ")) throw new Error("Unreleased must be empty; add notes in changelog.d.");
  if (changelog.includes(`\n## ${version}\n`)) throw new Error(`Changelog already contains ${version}.`);
  const notes = sections.flatMap((section) => {
    const matching = entries.filter((entry) => entry.section === section);
    return matching.length ? [`### ${section}\n\n${matching.map((entry) => entry.body).join("\n\n")}`] : [];
  }).join("\n\n");
  if (!notes) throw new Error("Release preparation requires at least one changelog fragment.");
  return `# Changelog\n\n${marker}\n\n## ${version}\n\n${notes}\n\n${history}`;
}
