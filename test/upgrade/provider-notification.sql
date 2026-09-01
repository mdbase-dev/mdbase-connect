-- Preserve one canonical application authority and seed three independent legacy
-- replicas. Each legacy row violates exactly one collection-level invariant so
-- the upgrade proves that no conjunctive migration bug can leave scoped authority.
INSERT INTO hosted_provider_replicas (
  id,
  collection_id,
  name,
  purpose,
  mode,
  allowed_types,
  contract_scope,
  full_collection,
  allowed_operations,
  operation_transport_protocol,
  operation_transport_recovery_protocols,
  allowed_origin,
  proof_public_key,
  grant_id,
  token_hash,
  token_expires_at
)
VALUES
(
  '55555555-5555-4555-8555-555555555555',
  '33333333-3333-4333-8333-333333333333',
  'Upgrade canonical application',
  'application',
  'read_write',
  ARRAY[]::text[],
  '[]'::jsonb,
  true,
  ARRAY['changes', 'create', 'put_timer']::text[],
  3,
  ARRAY[2]::integer[],
  'https://example.test',
  NULL,
  '22222222-2222-4222-8222-222222222222',
  decode('eed49890a43666f33a29e092602a716ea54a87c40ec89e2297d431d577573a0c', 'hex'),
  now() + interval '30 days'
),
(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '33333333-3333-4333-8333-333333333333',
  'Upgrade legacy full-collection-false application',
  'application',
  'read_write',
  ARRAY[]::text[],
  '[]'::jsonb,
  false,
  ARRAY['changes', 'create', 'put_timer']::text[],
  3,
  ARRAY[2]::integer[],
  'https://example.test',
  NULL,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  decode('ae970fb368089a280b851489a84c711d8dc597e4900e7d8b7c99c7d4390bf453', 'hex'),
  now() + interval '30 days'
),
(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '33333333-3333-4333-8333-333333333333',
  'Upgrade legacy allowed-types application',
  'application',
  'read_write',
  ARRAY['task']::text[],
  '[]'::jsonb,
  true,
  ARRAY['changes', 'create', 'put_timer']::text[],
  3,
  ARRAY[2]::integer[],
  'https://example.test',
  NULL,
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  decode('50b6d796f7808168514008dd601ef5639ec1e022c91ae359fffad62f7a1bad79', 'hex'),
  now() + interval '30 days'
),
(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  '33333333-3333-4333-8333-333333333333',
  'Upgrade legacy contract-scope application',
  'application',
  'read_write',
  ARRAY[]::text[],
  '[{
    "contract_type":"record",
    "id":"example.task",
    "version":"1.0.0",
    "digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "schema":{},
    "implementations":[]
  }]'::jsonb,
  true,
  ARRAY['changes', 'create', 'put_timer']::text[],
  3,
  ARRAY[2]::integer[],
  'https://example.test',
  NULL,
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  decode('b4792a7628ad5b8aa79d79eba31bb47ce016a1137816112f99ef4c1f67068587', 'hex'),
  now() + interval '30 days'
);

INSERT INTO hosted_provider_notification_grants
  (grant_id, collection_id, grant_json)
VALUES
(
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '{
    "id":"22222222-2222-4222-8222-222222222222",
    "application_id":"33333333-3333-4333-8333-333333333333",
    "application_declaration_id":"legacy.unbound.33333333333343338333333333333333",
    "application_manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000",
    "application_name":"Upgrade canary",
    "application_homepage":"https://example.test",
    "application_origin":"https://example.test",
    "collection_id":"33333333-3333-4333-8333-333333333333",
    "collection_name":"Upgrade canary",
    "operations":["changes","create","put_timer"],
    "scope":{"contracts":[],"access":"full_collection"},
    "notification_criteria":[{
      "id":"task.reminder",
      "event":{"id":"mdbase.runtime.timer.fired","version":"1.0.0","digest":"sha256:41105be7a7abf33b31ced47e1e1965242236e40ccaea286b959b0a8c591f5642"},
      "presentation":{"title":"Task reminder"}
    }],
    "contracts":{"operation_transport":3,"authorization_binding":5,"semantic_capabilities":1,"durable_mutation":1},
    "created_at":"2026-07-29T00:00:00Z"
  }'::jsonb
),
(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '33333333-3333-4333-8333-333333333333',
  '{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","application_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","application_declaration_id":"legacy.full-collection-false.upgrade","application_manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","application_name":"Upgrade legacy canary","application_homepage":"https://example.test","application_origin":"https://example.test","collection_id":"33333333-3333-4333-8333-333333333333","collection_name":"Upgrade canary","operations":["changes","create","put_timer"],"scope":{"contracts":[],"access":"full_collection"},"notification_criteria":[],"contracts":{"operation_transport":3,"authorization_binding":5,"semantic_capabilities":1,"durable_mutation":1},"created_at":"2026-07-29T00:00:00Z"}'::jsonb
),
(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '33333333-3333-4333-8333-333333333333',
  '{"id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","application_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","application_declaration_id":"legacy.allowed-types.upgrade","application_manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","application_name":"Upgrade legacy canary","application_homepage":"https://example.test","application_origin":"https://example.test","collection_id":"33333333-3333-4333-8333-333333333333","collection_name":"Upgrade canary","operations":["changes","create","put_timer"],"scope":{"contracts":[],"access":"full_collection"},"notification_criteria":[],"contracts":{"operation_transport":3,"authorization_binding":5,"semantic_capabilities":1,"durable_mutation":1},"created_at":"2026-07-29T00:00:00Z"}'::jsonb
),
(
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '33333333-3333-4333-8333-333333333333',
  '{"id":"ffffffff-ffff-4fff-8fff-ffffffffffff","application_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","application_declaration_id":"legacy.contract-scope.upgrade","application_manifest_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","application_name":"Upgrade legacy canary","application_homepage":"https://example.test","application_origin":"https://example.test","collection_id":"33333333-3333-4333-8333-333333333333","collection_name":"Upgrade canary","operations":["changes","create","put_timer"],"scope":{"contracts":[],"access":"full_collection"},"notification_criteria":[],"contracts":{"operation_transport":3,"authorization_binding":5,"semantic_capabilities":1,"durable_mutation":1},"created_at":"2026-07-29T00:00:00Z"}'::jsonb
);
