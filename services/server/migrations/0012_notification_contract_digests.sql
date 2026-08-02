-- mdbase:skip-if-missing-table applications
-- Exact contract requirements became mandatory in beta.25. These event
-- contracts are owned by Connect, so their semantic digests are known and can
-- be upgraded without guessing at application-owned contract identity.

UPDATE applications
SET notifications = replace(replace(
  notifications::text,
  '"event": {"id": "mdbase.record.created", "version": "1.0.0"}',
  '"event": {"id": "mdbase.record.created", "version": "1.0.0", "digest": "sha256:7f3bed6baa356ee9389e977ae7b77a102e2bee871a7c1d9f2026fc21cacdbfc9"}'
),
  '"event":{"id":"mdbase.record.created","version":"1.0.0"}',
  '"event":{"id":"mdbase.record.created","version":"1.0.0","digest":"sha256:7f3bed6baa356ee9389e977ae7b77a102e2bee871a7c1d9f2026fc21cacdbfc9"}'
)::jsonb
WHERE notifications::text LIKE '%mdbase.record.created%';

UPDATE applications
SET notifications = replace(replace(
  notifications::text,
  '"event": {"id": "mdbase.record.modified", "version": "1.0.0"}',
  '"event": {"id": "mdbase.record.modified", "version": "1.0.0", "digest": "sha256:064187148a95701a1f5c749643d306d3c6708470b6b7ab0bf0c698d38dbcabe3"}'
),
  '"event":{"id":"mdbase.record.modified","version":"1.0.0"}',
  '"event":{"id":"mdbase.record.modified","version":"1.0.0","digest":"sha256:064187148a95701a1f5c749643d306d3c6708470b6b7ab0bf0c698d38dbcabe3"}'
)::jsonb
WHERE notifications::text LIKE '%mdbase.record.modified%';

UPDATE applications
SET notifications = replace(replace(
  notifications::text,
  '"event": {"id": "mdbase.record.deleted", "version": "1.0.0"}',
  '"event": {"id": "mdbase.record.deleted", "version": "1.0.0", "digest": "sha256:84e5fb0f9d3bfdcd53f76cdc5035f94c7693fdea39a8ead190b10b422dd2ee09"}'
),
  '"event":{"id":"mdbase.record.deleted","version":"1.0.0"}',
  '"event":{"id":"mdbase.record.deleted","version":"1.0.0","digest":"sha256:84e5fb0f9d3bfdcd53f76cdc5035f94c7693fdea39a8ead190b10b422dd2ee09"}'
)::jsonb
WHERE notifications::text LIKE '%mdbase.record.deleted%';

UPDATE applications
SET notifications = replace(replace(
  notifications::text,
  '"event": {"id": "mdbase.record.renamed", "version": "1.0.0"}',
  '"event": {"id": "mdbase.record.renamed", "version": "1.0.0", "digest": "sha256:c825ef8d7db775b784d7af27e6acdf6f2799d2c6440d486f5bfa78afcca71471"}'
),
  '"event":{"id":"mdbase.record.renamed","version":"1.0.0"}',
  '"event":{"id":"mdbase.record.renamed","version":"1.0.0","digest":"sha256:c825ef8d7db775b784d7af27e6acdf6f2799d2c6440d486f5bfa78afcca71471"}'
)::jsonb
WHERE notifications::text LIKE '%mdbase.record.renamed%';

UPDATE applications
SET notifications = replace(replace(
  notifications::text,
  '"event": {"id": "mdbase.runtime.timer.fired", "version": "1.0.0"}',
  '"event": {"id": "mdbase.runtime.timer.fired", "version": "1.0.0", "digest": "sha256:41105be7a7abf33b31ced47e1e1965242236e40ccaea286b959b0a8c591f5642"}'
),
  '"event":{"id":"mdbase.runtime.timer.fired","version":"1.0.0"}',
  '"event":{"id":"mdbase.runtime.timer.fired","version":"1.0.0","digest":"sha256:41105be7a7abf33b31ced47e1e1965242236e40ccaea286b959b0a8c591f5642"}'
)::jsonb
WHERE notifications::text LIKE '%mdbase.runtime.timer.fired%';

UPDATE grants
SET notification_criteria = replace(replace(
  notification_criteria::text,
  '"event": {"id": "mdbase.record.created", "version": "1.0.0"}',
  '"event": {"id": "mdbase.record.created", "version": "1.0.0", "digest": "sha256:7f3bed6baa356ee9389e977ae7b77a102e2bee871a7c1d9f2026fc21cacdbfc9"}'
),
  '"event":{"id":"mdbase.record.created","version":"1.0.0"}',
  '"event":{"id":"mdbase.record.created","version":"1.0.0","digest":"sha256:7f3bed6baa356ee9389e977ae7b77a102e2bee871a7c1d9f2026fc21cacdbfc9"}'
)::jsonb
WHERE notification_criteria::text LIKE '%mdbase.record.created%';

UPDATE grants
SET notification_criteria = replace(replace(
  notification_criteria::text,
  '"event": {"id": "mdbase.record.modified", "version": "1.0.0"}',
  '"event": {"id": "mdbase.record.modified", "version": "1.0.0", "digest": "sha256:064187148a95701a1f5c749643d306d3c6708470b6b7ab0bf0c698d38dbcabe3"}'
),
  '"event":{"id":"mdbase.record.modified","version":"1.0.0"}',
  '"event":{"id":"mdbase.record.modified","version":"1.0.0","digest":"sha256:064187148a95701a1f5c749643d306d3c6708470b6b7ab0bf0c698d38dbcabe3"}'
)::jsonb
WHERE notification_criteria::text LIKE '%mdbase.record.modified%';

UPDATE grants
SET notification_criteria = replace(replace(
  notification_criteria::text,
  '"event": {"id": "mdbase.record.deleted", "version": "1.0.0"}',
  '"event": {"id": "mdbase.record.deleted", "version": "1.0.0", "digest": "sha256:84e5fb0f9d3bfdcd53f76cdc5035f94c7693fdea39a8ead190b10b422dd2ee09"}'
),
  '"event":{"id":"mdbase.record.deleted","version":"1.0.0"}',
  '"event":{"id":"mdbase.record.deleted","version":"1.0.0","digest":"sha256:84e5fb0f9d3bfdcd53f76cdc5035f94c7693fdea39a8ead190b10b422dd2ee09"}'
)::jsonb
WHERE notification_criteria::text LIKE '%mdbase.record.deleted%';

UPDATE grants
SET notification_criteria = replace(replace(
  notification_criteria::text,
  '"event": {"id": "mdbase.record.renamed", "version": "1.0.0"}',
  '"event": {"id": "mdbase.record.renamed", "version": "1.0.0", "digest": "sha256:c825ef8d7db775b784d7af27e6acdf6f2799d2c6440d486f5bfa78afcca71471"}'
),
  '"event":{"id":"mdbase.record.renamed","version":"1.0.0"}',
  '"event":{"id":"mdbase.record.renamed","version":"1.0.0","digest":"sha256:c825ef8d7db775b784d7af27e6acdf6f2799d2c6440d486f5bfa78afcca71471"}'
)::jsonb
WHERE notification_criteria::text LIKE '%mdbase.record.renamed%';

UPDATE grants
SET notification_criteria = replace(replace(
  notification_criteria::text,
  '"event": {"id": "mdbase.runtime.timer.fired", "version": "1.0.0"}',
  '"event": {"id": "mdbase.runtime.timer.fired", "version": "1.0.0", "digest": "sha256:41105be7a7abf33b31ced47e1e1965242236e40ccaea286b959b0a8c591f5642"}'
),
  '"event":{"id":"mdbase.runtime.timer.fired","version":"1.0.0"}',
  '"event":{"id":"mdbase.runtime.timer.fired","version":"1.0.0","digest":"sha256:41105be7a7abf33b31ced47e1e1965242236e40ccaea286b959b0a8c591f5642"}'
)::jsonb
WHERE notification_criteria::text LIKE '%mdbase.runtime.timer.fired%';
