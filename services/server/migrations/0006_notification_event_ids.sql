-- mdbase:skip-if-missing-table applications
-- Runtime profile 0.2 names runtime events under the stable mdbase.runtime
-- namespace. Applications and grants both retain notification criteria, so
-- migrate both durable copies before the control plane reads them.
UPDATE applications
SET notifications = replace(
  replace(
    notifications::text,
    '"event": {"id": "timer.fired"',
    '"event": {"id": "mdbase.runtime.timer.fired"'
  ),
  '"event":{"id":"timer.fired"',
  '"event":{"id":"mdbase.runtime.timer.fired"'
)::jsonb
WHERE notifications::text LIKE '%"event": {"id": "timer.fired"%'
   OR notifications::text LIKE '%"event":{"id":"timer.fired"%';

UPDATE grants
SET notification_criteria = replace(
  replace(
    notification_criteria::text,
    '"event": {"id": "timer.fired"',
    '"event": {"id": "mdbase.runtime.timer.fired"'
  ),
  '"event":{"id":"timer.fired"',
  '"event":{"id":"mdbase.runtime.timer.fired"'
)::jsonb
WHERE notification_criteria::text LIKE '%"event": {"id": "timer.fired"%'
   OR notification_criteria::text LIKE '%"event":{"id":"timer.fired"%';
