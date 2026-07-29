-- mdbase:skip-if-missing-table applications
-- Runtime profile 0.2 made the profile 0.1 integer contract version `1` an
-- exact semantic-version string. These JSON columns contain notification
-- criteria only, so the narrow textual rewrite cannot affect another model.
UPDATE applications
SET notifications = replace(
  replace(notifications::text, '"version": 1', '"version": "1.0.0"'),
  '"version":1',
  '"version":"1.0.0"'
)::jsonb
WHERE notifications::text LIKE '%"version": 1%'
   OR notifications::text LIKE '%"version":1%';

UPDATE grants
SET notification_criteria = replace(
  replace(notification_criteria::text, '"version": 1', '"version": "1.0.0"'),
  '"version":1',
  '"version":"1.0.0"'
)::jsonb
WHERE notification_criteria::text LIKE '%"version": 1%'
   OR notification_criteria::text LIKE '%"version":1%';
