import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assembleChangelog, fragments, parseFragment } from "./changelog.mjs";

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

test("a fresh checkout after consuming every fragment has no pending notes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "connect-empty-changelog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await fragments(root), []);
});

test("beta124 shipped notes remain released history during the next assembly", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const current = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const marker = "\n## 0.1.0-beta.124\n";
  const shippedHistory = current.slice(current.indexOf(marker));
  const shippedSection = shippedHistory.split("\n## 0.1.0-beta.107\n")[0];
  assert.match(shippedSection, /Migration note for SDK consumers/);
  assert.match(shippedSection, /Hosted required links to ordinary files/);
  const pending = await fragments(root);
  assert.ok(pending.every((entry) => !entry.name.startsWith("migrated-")));
  assert.ok(pending.every((entry) => !entry.body.includes("Migration note for SDK consumers") &&
    !entry.body.includes("Hosted required links to ordinary files")));
  const next = assembleChangelog(current, [{ section: "Changed", body: "- New unreleased change." }], "history-regression-check");
  assert.equal(next.slice(next.indexOf(marker)), shippedHistory);
});
