import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkStyleTokens } from "./check-style-tokens.mjs";

const check = (css) => checkStyleTokens(css, "fixture.css");

test("checks the installed UI CSS, not a different workspace copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "editor-style-package-"));
  const put = async (name, content) => {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  try {
    await Promise.all([
      put("apps/editor/src/editor.css", ".editor { font-size: var(--font-size-ui); }"),
      put("packages/app-ui/css/old.css", ".old { font-size: 9px; }"),
      put("apps/editor/node_modules/@mdbase-dev/ui/package.json", JSON.stringify({
        name: "@mdbase-dev/ui", exports: { "./tokens.css": "./css/tokens.css" }
      })),
      put("apps/editor/node_modules/@mdbase-dev/ui/css/tokens.css", ":root { --font-size-ui: 13px; }"),
      put("apps/editor/node_modules/@mdbase-dev/ui/css/shared.css", ".shared { font-size: var(--font-size-ui); }"),
      put("apps/editor/scripts/check-style-tokens.mjs", "")
    ]);
    const script = join(root, "apps/editor/scripts/check-style-tokens.mjs");
    await copyFile(new URL("./check-style-tokens.mjs", import.meta.url), script);
    const run = (entry = script, flags = []) => spawnSync(process.execPath, [...flags, entry], { encoding: "utf8" });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /2 editor\/shared stylesheets checked/);

    // macOS temp paths are aliases (/var -> /private/var). A directory junction
    // also exercises the original argv/canonical-module mismatch on Windows.
    const alias = join(root, "apps/editor-alias");
    await symlink(join(root, "apps/editor"), alias, "junction");
    const throughAlias = run(join(alias, "scripts/check-style-tokens.mjs"));
    assert.equal(throughAlias.status, 0, throughAlias.stderr);
    assert.match(throughAlias.stdout, /2 editor\/shared stylesheets checked/);

    // Do not compare a canonical argv to a presentation-only module URL. This
    // reproduces that asymmetric normalization even on a case-sensitive host.
    const preservedAlias = run(join(alias, "scripts/check-style-tokens.mjs"), ["--preserve-symlinks-main"]);
    assert.equal(preservedAlias.status, 0, preservedAlias.stderr);
    assert.match(preservedAlias.stdout, /2 editor\/shared stylesheets checked/);

    await put("apps/editor/node_modules/@mdbase-dev/ui/css/shared.css", ".shared { font-size: 9px; }");
    const expected = `${join("apps", "editor", "node_modules", "@mdbase-dev", "ui", "css", "shared.css")}:1: font-size must use shared tokens (9px).\n`;
    for (const [entry, flags] of [
      [script, []],
      [join(alias, "scripts/check-style-tokens.mjs"), []],
      [join(alias, "scripts/check-style-tokens.mjs"), ["--preserve-symlinks-main"]]
    ]) {
      const invalid = run(entry, flags);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stderr, expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects raw pixel typography including shorthands and variable fallbacks", () => {
  assert.equal(check(".a { font-size: 13px; font: 600 12px/1.5 sans-serif; --control-font-size: 11px; }").length, 3);
  assert.equal(check(".a { font-size: var(--caption, 11px); }").length, 1);
});

test("rejects raw radii, corner radii and ad-hoc shadows", () => {
  assert.equal(check(".a { border-radius: 4px 0; border-top-left-radius: 8px; box-shadow: 0 1em 2em red; }").length, 3);
  assert.equal(check(".a { border-radius: .25rem; }").length, 1);
});

test("accepts tokens, non-text geometry, proportional prose and circles", () => {
  assert.deepEqual(check(`.a {
    font-size: var(--font-size-ui); font: var(--font-size-caption)/1.5 var(--sans);
    border-radius: var(--radius-sm) 0 50%; border-bottom-right-radius: 0;
    box-shadow: var(--elevation-low); width: 13px; font-size: 1.2em;
  } .b { box-shadow: none !important; }`), []);
});

test("rejects malformed easing references and reports the declaration line", () => {
  assert.equal(check(".a { transition: opacity var(--motion-base) var(--var(--ease-out)); }").length, 1);
  assert.match(check(".a {\n  font-size: 11px;\n}")[0], /fixture\.css:2:/);
});

test("rejects forced uppercase/title case but allows the lowercase wordmark", () => {
  assert.equal(check(".a { text-transform: uppercase; } .b { text-transform: capitalize; }").length, 2);
  assert.deepEqual(check(".wordmark { text-transform: lowercase; } .label { text-transform: none; }"), []);
  assert.match(check(".a { text-transform: uppercase; }")[0], /sentence-case/);
});

test("ignores comments and string content, but not later declarations", () => {
  assert.equal(check(`/* font-size: 9px; */ .a {
    content: "font-size: 9px; border-radius: 9px";
    font-size: 11px;
  }`).length, 1);
});
