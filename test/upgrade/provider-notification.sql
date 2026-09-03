-- Seed one valid beta.94 collection-level application authority. The immediate
-- predecessor must be able to create terminal mutation state that the candidate
-- can reopen and replay without changing canonical persisted authority.
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
  decode('da3248855fed6608f5d17fa6c06a0a66d525bc65b71a5bffd386ab228db55684', 'hex'),
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
);
