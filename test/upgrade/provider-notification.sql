INSERT INTO hosted_provider_collections
  (id, template, spec_version, max_records, max_content_bytes,
   max_document_bytes, max_replicas, resource_revision,
   wrapped_data_key, resources_ciphertext)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'mdbase', '0.3',
   100, 1000000, 100000, 10, 'legacy', '\x00', '\x00');

INSERT INTO hosted_provider_notification_grants
  (grant_id, collection_id, grant_json)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  '{
    "id":"22222222-2222-4222-8222-222222222222",
    "application_id":"33333333-3333-4333-8333-333333333333",
    "application_name":"Upgrade canary",
    "application_homepage":"https://example.test",
    "application_origin":"https://example.test",
    "collection_id":"11111111-1111-4111-8111-111111111111",
    "collection_name":"Upgrade canary",
    "operations":["changes"],
    "scope":{"contracts":[],"access":"full_collection"},
    "notification_criteria":[{
      "id":"task.reminder",
      "event":{"id":"mdbase.runtime.timer.fired","version":"1.0.0"},
      "presentation":{"title":"Task reminder"}
    }],
    "created_at":"2026-07-29T00:00:00Z"
  }'::jsonb
);
