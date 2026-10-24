-- Runtime profile 0.2 made the profile 0.1 integer contract version `1` an
-- exact semantic-version string. Provider grants are a durable copy of the
-- control-plane grant and must be upgraded before Rust deserializes them.
UPDATE hosted_provider_notification_grants
SET grant_json = replace(
      replace(grant_json::text, '"version": 1', '"version": "1.0.0"'),
      '"version":1',
      '"version":"1.0.0"'
    )::jsonb,
    updated_at = now()
WHERE grant_json::text LIKE '%"version": 1%'
   OR grant_json::text LIKE '%"version":1%';
