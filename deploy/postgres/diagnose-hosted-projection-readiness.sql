-- Read-only. Why is each active collection unready, broken down by cause.
--
-- This is the query the 2026-08-18 incident needed and did not have. Readiness
-- failing tells an operator that something is wrong; this tells them which
-- collections and which condition, which is the difference between a fix and a
-- search. It mirrors the conditions in HostedProvider::ready and in
-- preflight-hosted-provider-final-cutover.sql, so a collection listed here is
-- one that will fail those gates.
--
-- Emits no record content: collection identifiers, counts and revision
-- identities only.
\pset pager off
SELECT
  collection.id AS collection_id,
  collection.state,
  collection.head,
  collection.active_projection_head,
  generation.status AS generation_status,
  generation.phase AS generation_phase,
  (collection.active_projection_generation_id IS NULL) AS no_generation,
  (generation.status IS DISTINCT FROM 'complete') AS generation_incomplete,
  (collection.active_projection_head IS DISTINCT FROM collection.head)
    AS head_mismatch,
  (generation.source_head > collection.active_projection_head)
    AS source_head_ahead,
  (generation.source_resource_revision
     IS DISTINCT FROM collection.resource_revision) AS resource_revision_stale,
  (generation.target_catalog_revision
     IS DISTINCT FROM collection.active_catalog_revision) AS catalog_stale,
  (generation.projection_format_version
     IS DISTINCT FROM collection.active_projection_format_version)
    AS format_version_mismatch,
  (generation.semantic_engine_version
     IS DISTINCT FROM collection.active_semantic_engine_version)
    AS engine_version_mismatch,
  (generation.integrity_epoch IS DISTINCT FROM generation.integrity_verified_epoch)
    AS integrity_unverified,
  generation.integrity_epoch,
  generation.integrity_verified_epoch,
  generation.projected_records,
  generation.resolved_records,
  collection.record_count,
  generation.last_error_code
FROM hosted_provider_collections collection
LEFT JOIN hosted_provider_projection_generations generation
  ON generation.collection_id = collection.id
 AND generation.generation_id = collection.active_projection_generation_id
WHERE collection.state = 'active'
  AND (
    collection.active_projection_generation_id IS NULL
    OR generation.status IS DISTINCT FROM 'complete'
    OR collection.active_projection_head IS DISTINCT FROM collection.head
    OR generation.source_head > collection.active_projection_head
    OR generation.source_resource_revision
         IS DISTINCT FROM collection.resource_revision
    OR generation.target_catalog_revision
         IS DISTINCT FROM collection.active_catalog_revision
    OR generation.projection_format_version
         IS DISTINCT FROM collection.active_projection_format_version
    OR generation.semantic_engine_version
         IS DISTINCT FROM collection.active_semantic_engine_version
    OR generation.integrity_epoch IS DISTINCT FROM generation.integrity_verified_epoch
  )
ORDER BY collection.id;
