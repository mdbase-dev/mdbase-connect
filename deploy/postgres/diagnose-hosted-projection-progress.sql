-- Read-only. How much projection work remains, and whether anything is moving.
--
-- The 2026-08-18 incident report records that the executor "can cancel
-- projection execution while reporting zero pages or batches advanced even
-- though durable per-collection checkpoints were committed", leaving the
-- recovery with no way to state remaining work or estimate completion. This
-- reads the durable checkpoints directly, so progress is visible between
-- attempts rather than only inside one.
--
-- Emits no record content: identifiers, counts, lease state and timings only.
\pset pager off
SELECT
  generation.collection_id,
  generation.generation_id,
  generation.status,
  generation.phase,
  collection.record_count AS expected_records,
  generation.projected_records,
  generation.resolved_records,
  GREATEST(collection.record_count - generation.projected_records, 0)
    AS records_left_to_project,
  GREATEST(collection.record_count - generation.resolved_records, 0)
    AS records_left_to_resolve,
  CASE
    WHEN collection.record_count > 0
      THEN round(100.0 * generation.resolved_records / collection.record_count, 1)
    ELSE NULL
  END AS resolved_percent,
  generation.checkpoint_record_id IS NOT NULL AS has_checkpoint,
  generation.lease_owner IS NOT NULL AS lease_held,
  generation.lease_expires_at,
  generation.lease_expires_at > now() AS lease_live,
  generation.lease_fencing_generation,
  generation.last_error_code,
  generation.created_at,
  generation.updated_at,
  now() - generation.updated_at AS since_last_progress
FROM hosted_provider_projection_generations generation
JOIN hosted_provider_collections collection
  ON collection.id = generation.collection_id
WHERE generation.status <> 'abandoned'
ORDER BY
  (generation.status = 'building') DESC,
  generation.updated_at DESC
LIMIT 200;
