-- Exact contract requirements became mandatory in beta.25. Provider grants
-- are a durable copy of the control-plane grant, so Connect-owned event
-- contracts can be upgraded deterministically before Rust deserializes them.
-- Unknown application-owned contracts are deliberately left untouched.
UPDATE hosted_provider_notification_grants AS stored_grant
SET grant_json = jsonb_set(
      stored_grant.grant_json,
      '{notification_criteria}',
      (
        SELECT jsonb_agg(
                 CASE criterion #>> '{event,id}'
                   WHEN 'mdbase.record.created' THEN
                     jsonb_set(
                       criterion,
                       '{event,digest}',
                       '"sha256:7f3bed6baa356ee9389e977ae7b77a102e2bee871a7c1d9f2026fc21cacdbfc9"'::jsonb,
                       true
                     )
                   WHEN 'mdbase.record.modified' THEN
                     jsonb_set(
                       criterion,
                       '{event,digest}',
                       '"sha256:064187148a95701a1f5c749643d306d3c6708470b6b7ab0bf0c698d38dbcabe3"'::jsonb,
                       true
                     )
                   WHEN 'mdbase.record.deleted' THEN
                     jsonb_set(
                       criterion,
                       '{event,digest}',
                       '"sha256:84e5fb0f9d3bfdcd53f76cdc5035f94c7693fdea39a8ead190b10b422dd2ee09"'::jsonb,
                       true
                     )
                   WHEN 'mdbase.record.renamed' THEN
                     jsonb_set(
                       criterion,
                       '{event,digest}',
                       '"sha256:c825ef8d7db775b784d7af27e6acdf6f2799d2c6440d486f5bfa78afcca71471"'::jsonb,
                       true
                     )
                   WHEN 'mdbase.runtime.timer.fired' THEN
                     jsonb_set(
                       criterion,
                       '{event,digest}',
                       '"sha256:41105be7a7abf33b31ced47e1e1965242236e40ccaea286b959b0a8c591f5642"'::jsonb,
                       true
                     )
                   ELSE criterion
                 END
                 ORDER BY ordinal
               )
        FROM jsonb_array_elements(stored_grant.grant_json -> 'notification_criteria')
             WITH ORDINALITY AS item(criterion, ordinal)
      ),
      false
    ),
    updated_at = now()
WHERE jsonb_typeof(stored_grant.grant_json -> 'notification_criteria') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(stored_grant.grant_json -> 'notification_criteria') AS item(criterion)
    WHERE criterion #>> '{event,id}' IN (
      'mdbase.record.created',
      'mdbase.record.modified',
      'mdbase.record.deleted',
      'mdbase.record.renamed',
      'mdbase.runtime.timer.fired'
    )
  );
