-- Runtime profile 0.2 names runtime events under the stable mdbase.runtime
-- namespace. Provider grants are a durable copy of the control-plane grant
-- and must be upgraded before Rust deserializes and validates them.
UPDATE hosted_provider_notification_grants
SET grant_json = replace(
      replace(
        grant_json::text,
        '"event": {"id": "timer.fired"',
        '"event": {"id": "mdbase.runtime.timer.fired"'
      ),
      '"event":{"id":"timer.fired"',
      '"event":{"id":"mdbase.runtime.timer.fired"'
    )::jsonb,
    updated_at = now()
WHERE grant_json::text LIKE '%"event": {"id": "timer.fired"%'
   OR grant_json::text LIKE '%"event":{"id":"timer.fired"%';
