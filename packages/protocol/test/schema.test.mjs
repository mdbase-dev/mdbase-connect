import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(resolve(here, "../schemas/connect-protocol.v1.schema.json"), "utf8"));
const manifestSchema = JSON.parse(readFileSync(resolve(here, "../schemas/mdbase-app.schema.json"), "utf8"));
const notificationWebhookSchema = JSON.parse(readFileSync(resolve(here, "../schemas/notification-webhook.v1.schema.json"), "utf8"));
const contractSchema = JSON.parse(readFileSync(resolve(here, "../schemas/data-contract.schema.json"), "utf8"));
const encryptedRelaySchema = JSON.parse(readFileSync(resolve(here, "../schemas/encrypted-relay.v1.schema.json"), "utf8"));
const interopSchema = JSON.parse(readFileSync(resolve(here, "../schemas/interop/v0.1/profile.schema.json"), "utf8"));
const syncSchema = JSON.parse(readFileSync(resolve(here, "../schemas/sync.v1.schema.json"), "utf8"));
// JSON Schema permits `required` to name properties declared by an enclosing
// schema. Keep every other strict check, but do not reject that standard
// composition pattern.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
ajv.addSchema(schema);
ajv.addSchema(manifestSchema);
ajv.addSchema(notificationWebhookSchema);
ajv.addSchema(contractSchema);
ajv.addSchema(encryptedRelaySchema);
ajv.addSchema(interopSchema);
ajv.addSchema(syncSchema);

function validator(reference) {
  const validate = ajv.getSchema(reference);
  assert.ok(validate, `missing compiled schema ${reference}`);
  return validate;
}

test("all canonical schemas compile as strict JSON Schema 2020-12", () => {
  assert.ok(validator(schema.$id));
  assert.ok(validator(manifestSchema.$id));
  assert.ok(validator(notificationWebhookSchema.$id));
  assert.ok(validator(contractSchema.$id));
  assert.ok(validator(encryptedRelaySchema.$id));
  assert.ok(validator(interopSchema.$id));
  assert.ok(validator(syncSchema.$id));
});

test("v1 application manifests carry a stable reverse-domain id", () => {
  const validate = validator(manifestSchema.$id);
  const declaration = {
    manifest_version: 1,
    id: "dev.mdbase.tasks",
    name: "Tasks",
    homepage: "https://tasks.example/",
    redirect_uris: [
      "https://tasks.example/auth/mdbase/callback",
      "dev.mdbase.tasks://auth/mdbase/callback"
    ],
    requirements: {
      contracts: [{ id: "example.work-item", version: "1.0.0" }]
    },
    notifications: {
      criteria: []
    }
  };
  assert.equal(validate(declaration), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...declaration, id: "tasks" }), false);
  assert.equal(validate({ ...declaration, manifest_version: 2 }), false);
});

test("v1 portable manifests explicitly avoid web origin claims", () => {
  const validate = validator(manifestSchema.$id);
  const declaration = {
    manifest_version: 1,
    distribution: "portable",
    id: "dev.mdbase.workouts",
    name: "Portable Workouts",
    project_url: "https://workouts.example/source",
    requirements: {
      contracts: [{ id: "workout.record", version: "1.0.0" }]
    }
  };
  assert.equal(validate(declaration), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...declaration,
    homepage: "https://workouts.example/",
    redirect_uris: ["https://workouts.example/callback"]
  }), false);
  assert.equal(validate({
    ...declaration,
    distribution: "web"
  }), false);
});

test("notification webhooks carry only an opaque wake-up signal", () => {
  const validate = validator(notificationWebhookSchema.$id);
  const webhook = {
    type: "mdbase.notification.webhook",
    version: 1,
    delivery_id: "01911111-1111-7111-8111-111111111111",
    connection_id: "01922222-2222-7222-8222-222222222222",
    notification: {
      type: "mdbase.notification",
      version: 1,
      signal_id: "signal_opaque",
      criterion_id: "task.changed",
      cursor: "42",
      presentation: {
        title: "Tasks changed",
        body: "Open Worklog to refresh.",
        tag: "task-change"
      }
    }
  };
  assert.equal(validate(webhook), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...webhook,
    notification: {
      ...webhook.notification,
      path: "private/task.md"
    }
  }), false);
});

test("application manifests declare authority-evaluated notification criteria", () => {
  const validate = validator(manifestSchema.$id);
  const manifest = {
    manifest_version: 1,
    id: "dev.mdbase.tasks",
    name: "Tasks",
    homepage: "https://tasks.example/",
    redirect_uris: ["https://tasks.example/callback"],
    notifications: {
      native_delivery: {
        mode: "managed_fcm",
        firebase_project_id: "tasks-production"
      },
      criteria: [{
        id: "task.ready",
        event: { id: "mdbase.record.modified", version: "1.0.0" },
        if: { $expr: "event.data.changed_fields.exists(field, field == 'status')" },
        debounce: "2s",
        minimum_interval: "1m",
        presentation: {
          title: "A task changed",
          body: "Open Tasks to see the latest update.",
          tag: "task-change"
        }
      }]
    }
  };
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...manifest, manifest_version: 2 }), false);
  assert.equal(validate({
    ...manifest,
    notifications: {
      ...manifest.notifications,
      criteria: [{ ...manifest.notifications.criteria[0], presentation: { title: "${event.data.path}" } }]
    }
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...manifest,
    notifications: {
      ...manifest.notifications,
      criteria: [{ ...manifest.notifications.criteria[0], event: { id: "../private", version: "1.0.0" } }]
    }
  }), false);
  assert.equal(validate({
    ...manifest,
    notifications: {
      ...manifest.notifications,
      native_delivery: {
        mode: "webhook",
        url: "https://hooks.tasks.example/mdbase"
      }
    }
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...manifest,
    notifications: {
      ...manifest.notifications,
      native_delivery: {
        mode: "managed_fcm",
        firebase_project_id: "../other-project"
      }
    }
  }), false);
  assert.equal(validate({
    ...manifest,
    notifications: {
      ...manifest.notifications,
      native_delivery: {
        mode: "webhook",
        url: "http://127.0.0.1/private"
      }
    }
  }), false);
});

test("application manifests declare connector-controlled type-pack provisioning", () => {
  const validate = validator(manifestSchema.$id);
  const manifest = {
    manifest_version: 1,
    id: "dev.mdbase.tasks",
    name: "Tasks",
    homepage: "https://tasks.example/",
    redirect_uris: ["https://tasks.example/callback"],
    requirements: {
      collection_kind: "hosted",
      access: "full_collection",
      contracts: [{ id: "example.work-item", version: "1.0.0" }]
    },
    provisions: {
      type_packs: [{
        manifest: {
          kind: "mdbase.type-pack",
          id: "example.tasks",
          version: "1.0.0",
          resources: [{
            kind: "contract",
            source: "contract.md",
            target: "_contracts/example.work-item.md",
            digest: `sha256:${"0".repeat(64)}`
          }]
        },
        resources: [{
          source: "contract.md",
          document: "---\nkind: mdbase.contract\ncontract_type: record\nid: example.work-item\nversion: 1.0.0\n---\n"
        }],
        provides: [{ id: "example.work-item", version: "1.0.0" }]
      }]
    }
  };
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...manifest, manifest_version: 2 }), false);
  assert.equal(validate({
    ...manifest,
    requirements: { ...manifest.requirements, collection_kind: "local" }
  }), false);
  assert.equal(validate({
    ...manifest,
    requirements: { ...manifest.requirements, access: "everything" }
  }), false);
  assert.equal(
    validate({
      ...manifest,
      provisions: {
        type_packs: [{ ...manifest.provisions.type_packs[0], provides: [] }]
      }
    }),
    true,
    JSON.stringify(validate.errors)
  );
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
      revision: "example-template:1",
      spec_version: "0.3.0",
      types: [{ name: "task", version: 1, schema: { type: "object" }, extensions: {} }],
      contracts: [{
        contract_type: "record",
        id: "example.work-item",
        version: "1.0.0",
        digest: `sha256:${"0".repeat(64)}`,
        schema: { type: "object" },
        implementations: [{
          type_name: "task",
          type_version: 1,
          type_path: "_types/task.md",
          digest: `sha256:${"1".repeat(64)}`,
          fields: { title: "title" }
        }]
      }]
    }
  };
  assert.equal(validateSession(session), true, JSON.stringify(validateSession.errors));
  assert.equal(validateWireObject(session), true, JSON.stringify(validateWireObject.errors));
  assert.equal(validateSession({ ...session, resources: { ...session.resources, revision: "" } }), false);

  const validateSnapshot = validator(`${syncSchema.$id}#/$defs/snapshotPage`);
  const snapshot = {
    protocol_version: 1,
    snapshot_id: session.snapshot_id,
    scope_epoch: 1,
    cursor: 0,
    records: [{
      record_id: "01977777-7777-7777-8777-777777777777",
      path: "tasks/one.md",
      revision: "record:1",
      frontmatter: { type: "task", title: "One" },
      body: "Do it.\n",
      types: ["task"],
      document: "---\ntype: task\ntitle: One\n---\nDo it.\n"
    }]
  };
  assert.equal(validateSnapshot(snapshot), true, JSON.stringify(validateSnapshot.errors));
  assert.equal(validateSnapshot({
    ...snapshot,
    records: snapshot.records.map(({ document: _, ...record }) => record)
  }), false);
});

test("encrypted relay envelopes expose routing metadata and reject payload-shaped fields", () => {
  const validate = validator(encryptedRelaySchema.$id);
  const envelope = {
    type: "encrypted_operation_request",
    protocol_version: 1,
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
  const hello = {
    type: "relay_hello",
    protocol_version: 1,
    connector_version: "0.1.0-beta.17",
    capabilities: [
      "authorization-activation",
      "encrypted-relay",
      "policy-ack"
    ]
  };
  assert.equal(validate(hello), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...hello, capabilities: ["policy-ack", "policy-ack"] }), false);
  const welcome = {
    type: "relay_welcome",
    protocol_version: 1,
    session_id: "42",
    capabilities: hello.capabilities
  };
  assert.equal(validate(welcome), true, JSON.stringify(validate.errors));

  const request = {
    type: "operation_request",
    protocol_version: 1,
    request_id: "01911111-1111-7111-8111-111111111111",
    grant_id: "01922222-2222-7222-8222-222222222222",
    collection_id: "01933333-3333-7333-8333-333333333333",
    application_id: "01944444-4444-7444-8444-444444444444",
    operation: "query",
    input: { types: ["task"] }
  };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...request, protocol_version: 2 }), false);
  assert.equal(validate({ ...request, local_path: "/private/vault" }), false);

  const response = {
    type: "operation_response",
    protocol_version: 1,
    request_id: request.request_id,
    ok: false,
    error: { code: "access_denied", message: "Denied" }
  };
  assert.equal(validate(response), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...response, result: {} }), false);

  const offer = {
    type: "authorization_offer_response",
    protocol_version: 1,
    request_id: request.request_id,
    paused: false,
    collections: [{
      collection_id: request.collection_id,
      display_name: "Tasks",
      spec_version: "0.3.0",
      contracts: []
    }]
  };
  assert.equal(validate(offer), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...offer,
    collections: [{ ...offer.collections[0], path: "/private/vault" }]
  }), false);

  const activation = {
    type: "authorization_activation_response",
    protocol_version: 1,
    request_id: request.request_id,
    ok: true,
    contracts: []
  };
  assert.equal(validate(activation), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...activation,
    ok: false
  }), false);

  const policy = {
    type: "policy_snapshot",
    protocol_version: 1,
    request_id: request.request_id,
    revision: `sha256:${"0".repeat(64)}`,
    grants: []
  };
  assert.equal(validate(policy), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...policy, revision: "latest" }), false);
  assert.equal(validate({
    type: "policy_applied",
    protocol_version: 1,
    request_id: request.request_id,
    revision: policy.revision,
    ok: true
  }), true, JSON.stringify(validate.errors));
});

test("collection descriptions and operation envelopes have addressable schemas", () => {
  const validateDescription = validator(`${schema.$id}#/$defs/collectionDescription`);
  const description = {
    protocol_version: 1,
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

test("data contracts require a stable identity, exact version, and JSON Schema", () => {
  const validate = validator(contractSchema.$id);
  assert.equal(validate({
    kind: "mdbase.contract",
    contract_type: "record",
    id: "example.work-item",
    version: "1.0.0",
    record_schema: {
      dialect: "json-schema-2020-12",
      value: { type: "object" }
    }
  }), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    kind: "mdbase.contract",
    contract_type: "record",
    id: "Invalid Contract",
    version: 1,
    record_schema: {
      dialect: "json-schema-2020-12",
      value: { type: "object" }
    }
  }), false);
});

test("portable event envelopes remain byte-for-byte compatible with the interop profile", () => {
  const validate = validator(`${interopSchema.$id}#/$defs/event`);
  const event = {
    specversion: "1.0",
    id: "event-01911111",
    source: "app://dev.tasknotes/tasknotes",
    type: "tasknotes.task.completed",
    time: "2026-07-28T00:00:00Z",
    subject: "task://tasks%2Fship-interop.md",
    datacontenttype: "application/json",
    dataschema: "https://tasknotes.dev/schemas/tasknotes-task-completed.schema.json",
    data: {
      task_id: "01911111-1111-7111-8111-111111111111",
      task_path: "tasks/ship-interop.md",
      title: "Ship event and action interoperability",
      status: "done",
      completed_at: "2026-07-28T00:00:00Z"
    },
    mdbaseprofile: "0.1",
    mdbasecontractversion: "1.0.0",
    mdbasecontractdigest: `sha256:${"0".repeat(64)}`,
    mdbaseapplication: "dev.tasknotes",
    mdbaseimplementation: "tasknotes.obsidian",
    mdbaseimplementationversion: "5.0.0"
  };

  assert.equal(validate(event), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...event, specversion: "0.3" }), false);
  assert.equal(validate({ ...event, InvalidExtension: true }), false);
});

test("portable action evidence preserves exact provider and contract identity", () => {
  const validateRequest = validator(`${interopSchema.$id}#/$defs/actionRequest`);
  const validateInvocation = validator(`${interopSchema.$id}#/$defs/actionInvocation`);
  const validateOutcome = validator(`${interopSchema.$id}#/$defs/actionOutcome`);
  const digest = `sha256:${"0".repeat(64)}`;
  const providerDigest = `sha256:${"1".repeat(64)}`;
  const caller = {
    application: "dev.tasknotes.workflows",
    implementation: "tasknotes-workflows.obsidian",
    version: "1.0.0"
  };
  const provider = {
    application: "dev.baseboard",
    implementation: "baseboard.obsidian",
    version: "1.0.0"
  };
  const contract = {
    id: "canvas.card.create",
    version: "1.0.0",
    digest
  };
  const request = {
    kind: "mdbase.action.request",
    profile_version: "0.1",
    request_id: "request-01911111",
    contract: { id: contract.id, version: "^1.0.0" },
    caller,
    created_at: "2026-07-28T00:00:00Z",
    input: { canvas_path: "boards/work.canvas", text: "Ship it" }
  };
  const invocation = {
    kind: "mdbase.action.invocation",
    profile_version: "0.1",
    invocation_id: "invocation-01911111",
    attempt_id: "attempt-01911111",
    request_id: request.request_id,
    contract,
    caller,
    provider,
    provider_declaration_digest: providerDigest,
    handler_id: "canvas-card-create",
    admitted_at: "2026-07-28T00:00:01Z",
    input: request.input
  };
  const outcome = {
    kind: "mdbase.action.outcome",
    profile_version: "0.1",
    outcome_id: "outcome-01911111",
    request_id: request.request_id,
    invocation_id: invocation.invocation_id,
    attempt_id: invocation.attempt_id,
    contract,
    provider,
    provider_declaration_digest: providerDigest,
    status: "succeeded",
    completed_at: "2026-07-28T00:00:02Z",
    output: { card_id: "card-01911111" }
  };

  assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateInvocation(invocation), true, JSON.stringify(validateInvocation.errors));
  assert.equal(validateOutcome(outcome), true, JSON.stringify(validateOutcome.errors));
  assert.equal(validateInvocation({ ...invocation, provider_declaration_digest: undefined }), false);
  assert.equal(validateOutcome({ ...outcome, contract: { ...contract, digest: undefined } }), false);
});
