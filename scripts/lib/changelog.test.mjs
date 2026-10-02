import assert from "node:assert/strict";
import test from "node:test";
import { assembleChangelog, parseFragment } from "./changelog.mjs";

const changelog = "# Changelog\n\n## Unreleased\n\n<!-- Add release notes in changelog.d; assembled by pnpm version:set. -->\n\n## 0.1.0-beta.1\n\n- History.\n";

test("fragments support one section and multiline bullets, reject malformed input", () => {
  assert.deepEqual(parseFragment("123-fix.md", "## Fixed\n\n- Fixed a bug.\n  Migration detail.\n"), {
    name: "123-fix.md", section: "Fixed", body: "- Fixed a bug.\n  Migration detail."
  });
  for (const [name, text] of [
    ["README.md", "## Fixed\n\n- Note.\n"],
    ["fix.md", "## Unsupported\n\n- Note.\n"],
    ["fix.md", "## Fixed\n\n"],
    ["fix.md", "## Fixed\n\nparagraph\n"],
    ["fix.md", "## Fixed\n\n-  \n"],
    ["fix.md", "## Fixed\n\n- Note.\n\n## Added\n\n- Other note.\n"],
    ["fix.md", "## Fixed\n\n- Note.\nunindented continuation\n"]
  ]) assert.throws(() => parseFragment(name, text));
});

test("assembly preserves history and groups notes in canonical section order", () => {
  const entries = [parseFragment("fix.md", "## Fixed\n\n- Fix.\n"), parseFragment("add.md", "## Added\n\n- Addition.\n")];
  const assembled = assembleChangelog(changelog, entries, "0.1.0-beta.2");
  assert.ok(assembled.endsWith("## 0.1.0-beta.1\n\n- History.\n"));
  assert.match(assembled, /## 0\.1\.0-beta\.2\n\n### Added\n\n- Addition\.\n\n### Fixed\n\n- Fix\./);
  assert.equal((assembled.match(/## Unreleased/g) ?? []).length, 1);
  assert.throws(() => assembleChangelog(assembled, entries, "0.1.0-beta.2"), /already contains/);
  assert.throws(() => assembleChangelog(changelog, [], "0.1.0-beta.2"), /at least one/);
  assert.throws(() => assembleChangelog(changelog.replace("<!--", "- Hand edit.\n<!--"), entries, "0.1.0-beta.2"), /fragment-managed/);
  assert.throws(() => assembleChangelog(changelog.replace("## 0.1.0-beta.1", "- Hand edit.\n\n## 0.1.0-beta.1"), entries, "0.1.0-beta.2"), /Unreleased must be empty/);
});
