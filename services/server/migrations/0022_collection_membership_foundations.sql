-- Collection membership is policy attached to one stable logical collection ID,
-- not to an application grant, hosted replica, or current authority row. Local
-- authorities use collections.local_id and hosted authorities use
-- hosted_collections.id, which are preserved across authority transfer.
--
-- Exact ceilings live in immutable policy revisions. Role names are presentation
-- presets only: changing a preset in application code cannot silently broaden an
-- existing membership.

CREATE TABLE collection_identities (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_principal_kind text NOT NULL DEFAULT 'user'
    CHECK (owner_principal_kind = 'user'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill both authority representations. A logical ID collision with a
-- different owner is retained as the first identity and fails closed when
-- access is resolved; ordinary transfer rows have the same owner.
INSERT INTO collection_identities (id, owner_user_id)
SELECT id, user_id FROM hosted_collections
ON CONFLICT (id) DO NOTHING;

CREATE TABLE collection_memberships (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES collection_identities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current_policy_id uuid,
  current_policy_revision integer CHECK (
    current_policy_revision IS NULL OR current_policy_revision > 0
  ),
  pending_policy_id uuid,
  pending_policy_revision integer CHECK (
    pending_policy_revision IS NULL OR pending_policy_revision > 0
  ),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'changing', 'revoking', 'revoked')),
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (current_policy_id IS NULL AND current_policy_revision IS NULL)
    OR
    (current_policy_id IS NOT NULL AND current_policy_revision IS NOT NULL)
  ),
  CHECK (
    (
      state = 'changing'
      AND pending_policy_id IS NOT NULL
      AND pending_policy_revision IS NOT NULL
    )
    OR
    (
      state <> 'changing'
      AND pending_policy_id IS NULL
      AND pending_policy_revision IS NULL
    )
  ),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL)
    OR (state <> 'revoked' AND revoked_at IS NULL)
  ),
  UNIQUE (id, user_id, collection_id)
);

CREATE UNIQUE INDEX collection_memberships_active_user_idx
  ON collection_memberships(collection_id, user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX collection_memberships_user_idx
  ON collection_memberships(user_id, collection_id)
  WHERE revoked_at IS NULL;

CREATE TABLE collection_membership_policies (
  id uuid PRIMARY KEY,
  membership_id uuid NOT NULL REFERENCES collection_memberships(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  role text NOT NULL CHECK (role IN ('viewer', 'editor')),
  preset_version integer NOT NULL CHECK (preset_version > 0),
  actions jsonb NOT NULL,
  operations jsonb NOT NULL,
  scope_ceiling jsonb NOT NULL,
  file_ceiling jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (membership_id, revision),
  UNIQUE (id, membership_id, revision)
);

CREATE INDEX collection_membership_policies_membership_idx
  ON collection_membership_policies(membership_id, revision);

ALTER TABLE collection_memberships
  ADD CONSTRAINT collection_memberships_current_policy_fk
  FOREIGN KEY (current_policy_id, id, current_policy_revision)
  REFERENCES collection_membership_policies(id, membership_id, revision);

ALTER TABLE collection_memberships
  ADD CONSTRAINT collection_memberships_pending_policy_fk
  FOREIGN KEY (pending_policy_id, id, pending_policy_revision)
  REFERENCES collection_membership_policies(id, membership_id, revision);
