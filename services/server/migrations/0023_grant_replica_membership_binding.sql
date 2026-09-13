-- mdbase:skip-if-missing-table applications
-- Bind every hosted application grant to the same replica user and collection.
-- Membership columns are nullable for rollback compatibility and legacy owner
-- grants, but when present they form one complete immutable policy binding.

ALTER TABLE grants
  ADD COLUMN logical_collection_id uuid,
  ADD COLUMN membership_id uuid,
  ADD COLUMN membership_policy_id uuid,
  ADD COLUMN membership_policy_revision integer;

ALTER TABLE hosted_replicas
  ADD COLUMN membership_id uuid,
  ADD COLUMN membership_policy_id uuid,
  ADD COLUMN membership_policy_revision integer;

UPDATE grants
SET logical_collection_id = hosted_collection_id
WHERE hosted_collection_id IS NOT NULL
  AND logical_collection_id IS NULL;

ALTER TABLE grants
  ADD CONSTRAINT grants_membership_binding_complete CHECK (
    (
      membership_id IS NULL
      AND membership_policy_id IS NULL
      AND membership_policy_revision IS NULL
    )
    OR
    (
      membership_id IS NOT NULL
      AND membership_policy_id IS NOT NULL
      AND membership_policy_revision IS NOT NULL
      AND membership_policy_revision > 0
      AND logical_collection_id IS NOT NULL
    )
  );

ALTER TABLE hosted_replicas
  ADD CONSTRAINT hosted_replicas_membership_binding_complete CHECK (
    (
      membership_id IS NULL
      AND membership_policy_id IS NULL
      AND membership_policy_revision IS NULL
    )
    OR
    (
      membership_id IS NOT NULL
      AND membership_policy_id IS NOT NULL
      AND membership_policy_revision IS NOT NULL
      AND membership_policy_revision > 0
      AND authorized_user_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX hosted_replicas_grant_binding_idx
  ON hosted_replicas(id, collection_id, authorized_user_id);

CREATE UNIQUE INDEX hosted_replicas_policy_binding_idx
  ON hosted_replicas(
    id,
    collection_id,
    authorized_user_id,
    membership_id,
    membership_policy_id,
    membership_policy_revision
  );

ALTER TABLE grants
  ADD CONSTRAINT grants_hosted_replica_binding_fkey
  FOREIGN KEY (hosted_replica_id, hosted_collection_id, user_id)
  REFERENCES hosted_replicas(id, collection_id, authorized_user_id);

ALTER TABLE grants
  ADD CONSTRAINT grants_membership_fkey
  FOREIGN KEY (membership_id, user_id, logical_collection_id)
  REFERENCES collection_memberships(id, user_id, collection_id);

ALTER TABLE grants
  ADD CONSTRAINT grants_membership_policy_fkey
  FOREIGN KEY (membership_policy_id, membership_id, membership_policy_revision)
  REFERENCES collection_membership_policies(id, membership_id, revision);

ALTER TABLE hosted_replicas
  ADD CONSTRAINT hosted_replicas_membership_fkey
  FOREIGN KEY (membership_id, authorized_user_id, collection_id)
  REFERENCES collection_memberships(id, user_id, collection_id);

ALTER TABLE hosted_replicas
  ADD CONSTRAINT hosted_replicas_membership_policy_fkey
  FOREIGN KEY (membership_policy_id, membership_id, membership_policy_revision)
  REFERENCES collection_membership_policies(id, membership_id, revision);

ALTER TABLE grants
  ADD CONSTRAINT grants_hosted_replica_policy_binding_fkey
  FOREIGN KEY (
    hosted_replica_id,
    hosted_collection_id,
    user_id,
    membership_id,
    membership_policy_id,
    membership_policy_revision
  )
  REFERENCES hosted_replicas(
    id,
    collection_id,
    authorized_user_id,
    membership_id,
    membership_policy_id,
    membership_policy_revision
  );
