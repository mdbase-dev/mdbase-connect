-- mdbase:skip-if-missing-table authority_transfers
-- Older inventory publication copied an importing target's epoch into its
-- exact local source and demoted that source to candidate. Restore only this
-- recognizable corruption, using the durable staged handoff as proof of the
-- source's pre-transfer epoch. Do not alter active sources, unrelated candidates,
-- cancelled history, or collections with another active local authority.
-- This repairs control-plane metadata only: the connector's durable fence must
-- remain until coordinated cancellation or successful activation.
UPDATE collections
SET authority_state = 'active',
    authority_epoch = repair.source_epoch,
    enabled = collections.reported_enabled
FROM (
  SELECT source.id, transfer.next_authority_epoch - 1 AS source_epoch
  FROM collections source
  JOIN authority_transfers transfer
    ON transfer.local_collection_id = source.id
   AND transfer.user_id = source.user_id
   AND transfer.direction = 'to_hosted'
   AND transfer.state IN ('requested', 'prepared', 'activating')
  JOIN hosted_collections hosted
    ON hosted.id = transfer.hosted_collection_id
   AND hosted.id = source.local_id
   AND hosted.user_id = transfer.user_id
   AND hosted.authority_state = 'importing'
   AND hosted.authority_epoch = transfer.next_authority_epoch
  JOIN connectors connector
    ON connector.id = source.connector_id
   AND connector.user_id = transfer.user_id
   AND connector.revoked_at IS NULL
  LEFT JOIN collections other_authority
    ON other_authority.user_id = transfer.user_id
   AND other_authority.local_id = hosted.id
   AND other_authority.authority_state = 'active'
   AND other_authority.id <> source.id
  WHERE source.present = true
    AND source.authority_state = 'candidate'
    AND source.authority_epoch = transfer.next_authority_epoch
    AND other_authority.id IS NULL
) repair
WHERE collections.id = repair.id;
