import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { describeError, INTERNAL_PROBLEM_CODES, NON_PROBLEM_CODES, PROBLEM_CODES, problemCodeOf } from "../src/describe-error.js";
import { ERROR_CODES } from "../src/errors.js";

/** Literal problem codes thrown or published anywhere in src/. */
function literalCodes(): Map<string, string> {
  const root = new URL("../src", import.meta.url).pathname, found = new Map<string, string>();
  const patterns = [
    /mdbaseError\(\s*"[a-z_]+"\s*,\s*(?:"[^"]*"|`[^`]*`|[^,()]+)\s*,\s*"([a-z][a-z0-9_]+)"/g,
    /\bproblem\s*:\s*"([a-z][a-z0-9_]+)"/g, /\bcode\s*:\s*"([a-z][a-z0-9_]+)"/g, /\breason\s*:\s*"([a-z][a-z0-9_]+)"/g,
    /new [A-Z][A-Za-z]*Error\(\s*"([a-z][a-z0-9_]+)"/g, /\b(?:fail|refuse|blocked|problem|reject|failure)\(\s*"([a-z][a-z0-9_]+)"/g,
  ];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".ts")) { const text = readFileSync(path, "utf8");
      for (const re of patterns) for (const m of text.matchAll(re)) if (!found.has(m[1]!)) found.set(m[1]!, path.slice(root.length + 1)); }
  } };
  walk(root);
  return found;
}

it("classifies every problem code the SDK throws or publishes", () => {
  const known = new Set<string>([...INTERNAL_PROBLEM_CODES, ...NON_PROBLEM_CODES, ...Object.keys(ERROR_CODES)]);
  const codes = literalCodes();
  expect(codes.size).toBeGreaterThan(200);
  const unclassified = [...codes].filter(([code]) => problemCodeOf(code) === null && problemCodeOf(`configuration_${code}`) === null && !known.has(code))
    .map(([code, file]) => `${code} (${file})`);
  expect(unclassified).toEqual([]);
});

it("gives every user-facing code plain copy, never the generic fallback or a raw code", () => {
  for (const code of PROBLEM_CODES) {
    const d = describeError(code)!;
    expect(d.key, code).toBe(code);
    expect(d.title).not.toMatch(/_/);
    if (code.includes("_")) expect(d.message).not.toContain(code);
  }
});

it("returns null for outcomes that are not problems", () => {
  for (const code of NON_PROBLEM_CODES) expect(describeError(code), code).toBeNull();
  expect(describeError({ code: "cancelled", reason: "application_entry_fenced" })).toMatchObject({ key: "busy" });
});
