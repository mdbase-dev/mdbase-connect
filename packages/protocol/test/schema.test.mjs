import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolve(here, "../schemas/connect-protocol.v2.schema.json"), "utf8"));
const manifestSchema = JSON.parse(readFileSync(resolve(here, "../schemas/mdbase-app.schema.json"), "utf8"));
const contractSchema = JSON.parse(readFileSync(resolve(here, "../schemas/contract-extension.v1.schema.json"), "utf8"));
const encryptedRelaySchema = JSON.parse(readFileSync(resolve(here, "../schemas/encrypted-relay.v3.schema.json"), "utf8"));
const syncSchema = JSON.parse(readFileSync(resolve(here, "../schemas/sync.v1.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(schema);
ajv.addSchema(manifestSchema);
ajv.addSchema(contractSchema);
ajv.addSchema(encryptedRelaySchema);
ajv.addSchema(syncSchema);

function validator(reference) {
  const validate = ajv.getSchema(reference);
  assert.ok(validate, `missing compiled schema ${reference}`);
  return validate;
}

test("all canonical schemas compile as strict JSON Schema 2020-12", () => {
  assert.ok(validator(schema.$id));
  assert.ok(validator(manifestSchema.$id));
  assert.ok(validator(contractSchema.$id));
  assert.ok(validator(encryptedRelaySchema.$id));
  assert.ok(validator(syncSchema.$id));
});

test("application manifests declare connector-controlled type provisioning", () => {
  const validate = validator(manifestSchema.$id);
  const manifest = {
    manifest_version: 1,
    name: "Tasks",
    homepage: "https://tasks.example/",
    redirect_uris: ["https://tasks.example/callback"],
    requirements: { contracts: [{ id: "tasknotes.task", version: 1 }] },
    provisions: {
      types: [{
        name: "Task",
        document: "---\nkind: mdbase.type\nname: task\n---\n",
        provides: [{ id: "tasknotes.task", version: 1 }]
      }]
    }
  };
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...manifest, manifest_version: 2 }), false);
  assert.equal(validate({ ...manifest, provisions: { types: [{ ...manifest.provisions.types[0], provides: [] }] } }), false);
});

test("sync wire objects are independently addressable", () => {
  const validateWireObject = validator(syncSchema.$id);
  const validateMutation = validator(`${syncSchema.$id}#/$defs/mutation`);
  const mutation = {
    mutation_id: "01911111-1111-7111-8111-111111111111",
    replica_id: "01922222-2222-7222-8222-222222222222",
    scope_epoch: 1,
    operation: "create",
    record_id: "01933333-3333-7333-8333-333333333333",
    input: { path: "tasks/one.md", frontmatter: { type: "task", title: "One" } },
    created_at: "2026-07-21T00:00:00Z"
  };
  assert.equal(validateMutation(mutation), true, JSON.stringify(validateMutation.errors));
  assert.equal(validateWireObject(mutation), true, JSON.stringify(validateWireObject.errors));
  assert.equal(validateMutation({ ...mutation, operation: "overwrite" }), false);
  assert.equal(validateWireObject({ unexpected: true }), false);
  const validateReceipt = validator(`${syncSchema.$id}#/$defs/receipt`);
  assert.equal(validateReceipt({
    mutation_id: mutation.mutation_id,
    status: "rejected",
    error: { code: "scope_denied", message: "Denied" }
  }), true, JSON.stringify(validateReceipt.errors));

  const validateSession = validator(`${syncSchema.$id}#/$defs/session`);
  const session = {
    protocol_version: 1,
    session_id: "01944444-4444-7444-8444-444444444444",
    replica_id: mutation.replica_id,
    collection_id: "01955555-5555-7555-8555-555555555555",
    mode: "read_write",
    scope_epoch: 1,
    retained_after: 0,
    head: 0,
    snapshot_id: "01966666-6666-7666-8666-666666666666",
    resources: {
      revision: "tasknotes-template:1",
      spec_version: "0.3.0",
      types: [{ name: "task", version: 1, schema: { type: "object" }, extensions: {} }],
      contracts: [{
        id: "tasknotes.task",
        version: 1,
        type_name: "task",
        extension: "x-tasknotes",
        configuration: { contract: "tasknotes.task", version: 1 }
      }]
    }
  };
  assert.equal(validateSession(session), true, JSON.stringify(validateSession.errors));
  assert.equal(validateWireObject(session), true, JSON.stringify(validateWireObject.errors));
  assert.equal(validateSession({ ...session, resources: { ...session.resources, revision: "" } }), false);
});

test("encrypted relay envelopes expose routing metadata and reject payload-shaped fields", () => {
  const validate = validator(encryptedRelaySchema.$id);
  const envelope = {
    type: "encrypted_operation_request",
    protocol_version: 3,
    suite: "P256-HKDF-SHA256-AES256GCM",
    request_id: "01911111-1111-7111-8111-111111111111",
    grant_id: "01922222-2222-7222-8222-222222222222",
    application_id: "01933333-3333-7333-8333-333333333333",
    connector_id: "01944444-4444-7444-8444-444444444444",
    collection_id: "01955555-5555-7555-8555-555555555555",
    operation: "query",
    scope_epoch: 1,
    key_id: "enc_test",
    counter: "1",
    ciphertext: "opaque_ciphertext"
  };
  assert.equal(validate(envelope), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...envelope, input: { path: "private.md" } }), false);
  assert.equal(validate({ ...envelope, counter: "01" }), false);
  assert.equal(validate({ ...envelope, type: "operation_request" }), false);
});

test("relay request and response discriminators reject malformed wire messages", () => {
  const validate = validator(schema.$id);
  const request = {
    type: "operation_request",
    protocol_version: 2,
    request_id: "01911111-1111-7111-8111-111111111111",
    grant_id: "01922222-2222-7222-8222-222222222222",
    collection_id: "01933333-3333-7333-8333-333333333333",
    application_id: "01944444-4444-7444-8444-444444444444",
    operation: "query",
    input: { types: ["task"] }
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...request, protocol_version: 3 }), false);
  assert.equal(validate({ ...request, local_path: "/private/vault" }), false);

  const response = {
    type: "operation_response",
    protocol_version: 2,
    request_id: request.request_id,
    ok: false,
    error: { code: "access_denied", message: "Denied" }
  };
  assert.equal(validate(response), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...response, result: {} }), false);
});

test("collection descriptions and operation envelopes have addressable schemas", () => {
  const validateDescription = validator(`${schema.$id}#/$defs/collectionDescription`);
  const description = {
    protocol_version: 2,
    collection_id: "01933333-3333-7333-8333-333333333333",
    display_name: "Tasks",
    spec_version: "0.3.0",
    operations: ["describe", "query"],
    change_cursor: 0,
    types: [],
    contracts: []
  };
  assert.equal(validateDescription(description), true, JSON.stringify(validateDescription.errors));
  assert.equal(validateDescription({ ...description, path: "/private/vault" }), false);

  const validateEnvelope = validator(`${schema.$id}#/$defs/operationEnvelope`);
  assert.equal(validateEnvelope({ valid: true, result: {}, diagnostics: [] }), true);
  assert.equal(validateEnvelope({ valid: true, result: {} }), false);
});

test("contract extensions require a stable contract identity and version", () => {
  const validate = validator(contractSchema.$id);
  assert.equal(validate({ contract: "tasknotes.task", version: 1, field_roles: {} }), true);
  assert.equal(validate({ contract: "Task Notes", version: 0 }), false);
});
