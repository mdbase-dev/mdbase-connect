import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { isConnectProblemCode } from "../dist/connect-problems.generated.js";

// A structured provider 403 must not turn into an unknown SDK problem merely
// because its code was omitted from the shared Rust/TypeScript catalog.
test("every hosted provider forbidden code is in the canonical problem catalog", () => {
  const root = resolve(import.meta.dirname, "../../../crates/connect-hosted-provider/src");
  const codes = new Set();
  for (const file of readdirSync(root, { recursive: true })) {
    if (!file.endsWith(".rs")) continue;
    const source = readFileSync(resolve(root, file), "utf8");
    for (const match of source.matchAll(/ApiError::forbidden\(\s*"([a-z0-9_]+)"/gu)) {
      codes.add(match[1]);
    }
  }
  assert.ok(codes.has("origin_denied"), "provider forbidden calls were not discovered");
  for (const code of codes) assert.ok(isConnectProblemCode(code), `missing provider problem: ${code}`);
});
