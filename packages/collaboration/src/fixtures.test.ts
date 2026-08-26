import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BODY_ROOT, markdownBody } from "./index.js";

const LIMIT = 1024 * 1024;
const fixtureDir = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../test/fixtures/collaboration-v1"
);
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(fixtureDir, name)));
const text = (name: string) => readFileSync(resolve(fixtureDir, name), "utf8");

function restored(initial = bytes("yjs-initial-update-v1.bin")): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(BODY_ROOT);
  Y.applyUpdate(doc, initial);
  return doc;
}

describe("Yjs/Yrs collaboration v1 fixtures", () => {
  it("pins and verifies every binary fixture", () => {
    const manifest = JSON.parse(text("manifest.json")) as {
      yjs_version: string;
      yrs_version: string;
      profile: string;
      files: Record<string, { bytes: number; sha256: string }>;
    };
    expect(manifest).toMatchObject({
      yjs_version: "13.6.32",
      yrs_version: "0.26.0",
      profile: "markdown-body-yjs-v13"
    });
    for (const [name, expected] of Object.entries(manifest.files)) {
      const content = bytes(name);
      expect(content.byteLength, name).toBe(expected.bytes);
      expect(createHash("sha256").update(content).digest("hex"), name)
        .toBe(expected.sha256);
    }
  });

  it("applies Yrs and Yjs concurrent updates in either order", () => {
    const provider = bytes("yrs-provider-update-v1.bin");
    const offline = bytes("yjs-offline-update-v1.bin");
    const first = restored();
    Y.applyUpdate(first, provider);
    Y.applyUpdate(first, offline);
    Y.applyUpdate(first, offline);
    const second = restored();
    Y.applyUpdate(second, offline);
    Y.applyUpdate(second, provider);
    Y.applyUpdate(second, provider);

    const expected = text("expected-converged-body.txt");
    expect(markdownBody(first, LIMIT)).toBe(expected);
    expect(markdownBody(second, LIMIT)).toBe(expected);
    expect([...Y.encodeStateVector(first)]).toEqual([...Y.encodeStateVector(second)]);
  });

  it("synchronizes an old Yjs state vector after Yrs compaction", () => {
    const stale = restored();
    Y.applyUpdate(stale, bytes("yrs-diff-from-old-vector-v1.bin"));
    expect(markdownBody(stale, LIMIT)).toBe(text("expected-converged-body.txt"));

    const fresh = restored(bytes("yrs-compacted-snapshot-v1.bin"));
    expect(markdownBody(fresh, LIMIT)).toBe(text("expected-converged-body.txt"));
    expect([...Y.encodeStateVector(stale)]).toEqual([...Y.encodeStateVector(fresh)]);
  });
});
