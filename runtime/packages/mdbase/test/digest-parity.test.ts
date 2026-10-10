/**
 * Cross-engine digest parity: the new engine's `contractDigest` equals the old
 * TS engine's `dataContractDigest` (`@callumalpass/mdbase` 0.3.0-rc.9) on the
 * vendored spec corpus and on a local corpus covering every contract type.
 *
 * The old function hashes a frontmatter object whose `ref` wrappers were already
 * resolved by its registry, so this test resolves them the same way (relative
 * path + JSON Pointer). Known divergences are documented in
 * `docs/library/README.md` and excluded here: `+build` metadata in `version`
 * (the new engine drops it, as the spec says) and `collection.display` in
 * implementation digests.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dataContractDigest } from "@callumalpass/mdbase";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { contractDigest } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, "../../../conformance/spec");

const SCHEMA_MEMBERS: Record<string, string[]> = {
  record: ["record_schema", "binding_schema"],
  event: ["data_schema", "source_schema"],
  action: ["input_schema", "output_schema", "error_schema", "provider_schema"],
};

function frontmatterOf(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) throw new Error("no frontmatter");
  return yaml.load(m[1]!) as Record<string, unknown>;
}

function pointer(doc: unknown, fragment: string): unknown {
  if (!fragment) return doc;
  let cur: unknown = doc;
  for (const raw of fragment.replace(/^\//, "").split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The old registry's "portable" object: wrappers resolved, `value` set. */
function oldPortable(file: string): Record<string, unknown> {
  const fm = frontmatterOf(readFileSync(file, "utf8"));
  const out: Record<string, unknown> = {
    kind: "mdbase.contract",
    contract_type: fm["contract_type"],
    id: String(fm["id"]),
    version: String(fm["version"]),
  };
  for (const member of SCHEMA_MEMBERS[String(fm["contract_type"])] ?? []) {
    const w = fm[member] as { dialect: string; value?: unknown; ref?: string } | undefined;
    if (!w) continue;
    let value = w.value;
    if (w.ref) {
      const [p, frag = ""] = w.ref.split("#") as [string, string?];
      const doc: unknown = JSON.parse(readFileSync(join(dirname(file), p), "utf8"));
      value = pointer(doc, frag);
    }
    out[member] = { dialect: "json-schema-2020-12", value, ...(w.ref ? { ref: w.ref } : {}) };
  }
  if (fm["behavior"] && typeof fm["behavior"] === "object" && !Array.isArray(fm["behavior"])) {
    out["behavior"] = fm["behavior"];
  }
  return out;
}

/** The same file for the new engine: text plus the referenced files as resources. */
function newInput(file: string) {
  const fm = frontmatterOf(readFileSync(file, "utf8"));
  const resources: Record<string, string> = {};
  for (const member of SCHEMA_MEMBERS[String(fm["contract_type"])] ?? []) {
    const w = fm[member] as { ref?: string } | undefined;
    if (w?.ref) {
      const p = w.ref.split("#")[0]!;
      resources[`_contracts/${p}`] = readFileSync(join(dirname(file), p), "utf8");
    }
  }
  return { source: readFileSync(file, "utf8"), path: `_contracts/${file.split("/").pop()}`, resources };
}

const corpus: [string, string][] = [
  ["spec example", join(SPEC, "examples/v0.3/tasknotes-migration/v0.3/_contracts/tasknotes.task.md")],
  ["spec fixture: conflicting", join(SPEC, "tests/v0.3/fixtures/data-contracts/conflicting-tasknotes.task.md")],
  ["spec fixture: json-pointer ref", join(SPEC, "tests/v0.3/fixtures/data-contracts/json-pointer-contact.contract.md")],
  ...readdirSync(join(here, "corpus"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f): [string, string] => [`corpus: ${f}`, join(here, "corpus", f)]),
];

describe("contract digest parity with @callumalpass/mdbase", () => {
  it.each(corpus)("%s", async (_name, file) => {
    const old = dataContractDigest(oldPortable(file));
    const fresh = await contractDigest(newInput(file));
    expect(fresh.digest).toBe(old);
  });

  it("the spec's expected digest is what both engines produce", async () => {
    const file = corpus[0]![1];
    const expected = "sha256:a49d25136bf3024e146017771d068cdf59abfddbcdd1bfbf8010018c7f13f476";
    expect(dataContractDigest(oldPortable(file))).toBe(expected);
    expect((await contractDigest(newInput(file))).digest).toBe(expected);
  });
});
