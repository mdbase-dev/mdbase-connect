import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { FILE_CONTROL_MESSAGE_TYPES, isMutatingOperation, operationInputSchemaVersion, MAX_READ_MANY_PATHS, MAX_READ_MANY_RESPONSE_BYTES } from "../dist/index.js";

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const fixture = load("./fixtures/authority-features-v1.json");
const protocol = load("../schemas/connect-protocol.v1.schema.json");
const files = load("../schemas/files.v1.schema.json");
const query = load("../schemas/mdbase-query.v0.3.schema.json");
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(load("../schemas/connect-problem.v1.schema.json"));
for (const schema of [protocol, files, query]) ajv.addSchema(schema);
const check = (schema, name, value, expected = true) => {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  assert.equal(validate(value), expected, JSON.stringify(validate.errors));
};

test("authority feature fixtures match canonical schemas, including legacy absence", () => {
  for (const key of ["description", "legacy_description"]) check(protocol, "collectionDescription", fixture[key]);
  for (const key of ["files_page", "legacy_files_page"]) check(files, "listFilesPage", fixture[key]);
  for (const key of ["query_record", "legacy_query_record"]) check(protocol, "queryRecord", fixture[key]);
  check(protocol, "queryMetadataResult", fixture.metadata_result);
  check(protocol, "readInput", fixture.batch_input);
  check(protocol, "readManyDocumentsResult", fixture.batch_result);
  for (const key of ["stat_path", "stat_id"]) check(files, "statFileRequest", fixture[key]);
  for (const key of ["stat_found", "stat_missing"]) check(files, "fileStat", fixture[key]);
});

test("strict targets, nulls, extras and batch limits reject malformed extended inputs", () => {
  for (const value of fixture.invalid_stat_inputs) check(files, "statFileRequest", value, false);
  for (const value of fixture.invalid_read_inputs) check(protocol, "readInput", value, false);
  check(files, "statFileRequest", { ...fixture.stat_path, path: "../secret.pdf" }, false);
  check(protocol, "readInput", { paths: Array(MAX_READ_MANY_PATHS).fill("a.md") });
  check(protocol, "readInput", { paths: Array(MAX_READ_MANY_PATHS + 1).fill("a.md") }, false);
  assert.equal(MAX_READ_MANY_RESPONSE_BYTES, 8 * 1024 * 1024);
});

test("metadata is revision-required and cannot masquerade as a document", () => {
  const row = fixture.metadata_result.results[0];
  for (const key of ["revision", "values"]) {
    const { [key]: omitted, ...partial } = row;
    check(protocol, "queryMetadataRecord", partial, false);
  }
  for (const key of ["file", "frontmatter", "effective_frontmatter", "body", "document"]) {
    check(protocol, "queryMetadataRecord", { ...row, [key]: key === "body" || key === "document" ? "" : {} }, false);
  }
  const validate = ajv.getSchema(query.$id);
  assert.equal(validate({ output: "metadata" }), true);
  assert.equal(validate({ output: "metadata", include_body: true }), false);
  assert.equal(validate({ output: "metadata", select: [] }), false);
});

test("stat is a nonmutating version-1 canonical file discriminator", () => {
  assert.ok(FILE_CONTROL_MESSAGE_TYPES.includes("stat_file"));
  assert.equal(operationInputSchemaVersion("file_control", fixture.stat_path), 1);
  assert.equal(isMutatingOperation("file_control", fixture.stat_path), false);
});

// Frozen predecessor response readers ignore additive members, as the N-1 SDK
// normalizers do. Old strict JSON schemas are not forward-compatible validators.
// Consumer: late-updated SDKs; retain until minimum-SDK and rollback windows close.
test("N-1 response projections remain unchanged by feature advertisements/revisions", () => {
  for (const [legacy, current, addition] of [
    ["legacy_description", "description", "authority_capabilities"],
    ["legacy_files_page", "files_page", "authority_capabilities"],
    ["legacy_query_record", "query_record", "revision"]
  ]) {
    const { [addition]: ignored, ...predecessor } = fixture[current];
    assert.deepEqual(predecessor, fixture[legacy]);
  }
});
