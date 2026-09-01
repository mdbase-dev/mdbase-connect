-- Application authority is collection-wide. Preserve legacy bearer material only
-- for exact terminal mutation replay, then retire every scoped application
-- replica and its independently persisted notification authority.
INSERT INTO hosted_provider_retired_replay_credentials (
  replica_id, token_hash, allowed_origin, proof_public_key, expires_at
)
SELECT id, token_hash, allowed_origin, proof_public_key,
       LEAST(token_expires_at, now() + interval '365 days')
FROM hosted_provider_replicas
WHERE purpose = 'application'
  AND revoked_at IS NULL
  AND token_expires_at > now()
  AND EXISTS (
    SELECT 1
    FROM hosted_provider_mutation_journal journal
    WHERE journal.replica_id = hosted_provider_replicas.id
      AND journal.state = 'completed'
  )
  AND (
    full_collection = false
    OR cardinality(allowed_types) <> 0
    OR contract_scope <> '[]'::jsonb
  );

DELETE FROM hosted_provider_notification_grants notification
WHERE notification.grant_json -> 'scope'
        IS DISTINCT FROM '{"access":"full_collection","contracts":[]}'::jsonb
   OR EXISTS (
     SELECT 1
     FROM hosted_provider_replicas replica
     WHERE replica.grant_id = notification.grant_id
       AND replica.purpose = 'application'
       AND (
         replica.full_collection = false
         OR cardinality(replica.allowed_types) <> 0
         OR replica.contract_scope <> '[]'::jsonb
       )
   );

UPDATE hosted_provider_replicas
SET revoked_at = now()
WHERE purpose = 'application'
  AND revoked_at IS NULL
  AND (
    full_collection = false
    OR cardinality(allowed_types) <> 0
    OR contract_scope <> '[]'::jsonb
  );
