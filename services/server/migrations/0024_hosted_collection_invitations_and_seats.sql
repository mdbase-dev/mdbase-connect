-- Current/pending policy pointers are resolved with an exact membership/revision
-- join and fail closed. The original cyclic foreign keys prevent the intended
-- users -> memberships -> policies account-deletion cascade, so remove them in
-- a forward migration while retaining relational policy binding on every
-- derived grant and replica.
ALTER TABLE collection_memberships
  DROP CONSTRAINT collection_memberships_current_policy_fk,
  DROP CONSTRAINT collection_memberships_pending_policy_fk;

ALTER TABLE entitlement_profiles
  ADD COLUMN max_collection_member_seats bigint NOT NULL DEFAULT 10
  CHECK (max_collection_member_seats >= 0);

UPDATE entitlement_profiles
SET max_collection_member_seats = 10
WHERE code = 'beta_v1';

CREATE TABLE collection_invitation_codes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX collection_invitation_codes_active_user_idx
  ON collection_invitation_codes(user_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE collection_invitations (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES collection_identities(id) ON DELETE CASCADE,
  invited_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_mode text NOT NULL CHECK (target_mode IN ('email', 'invitee_code')),
  submitted_email text,
  target_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  invitation_code_id uuid UNIQUE
    REFERENCES collection_invitation_codes(id) ON DELETE SET NULL,
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('viewer', 'editor')),
  preset_version integer NOT NULL CHECK (preset_version > 0),
  actions jsonb NOT NULL,
  operations jsonb NOT NULL,
  scope_ceiling jsonb NOT NULL,
  file_ceiling jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'accepted', 'revoked')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  accepted_membership_id uuid UNIQUE
    REFERENCES collection_memberships(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (
    (target_mode = 'email' AND submitted_email IS NOT NULL
      AND invitation_code_id IS NULL)
    OR
    (target_mode = 'invitee_code' AND submitted_email IS NULL
      AND target_user_id IS NOT NULL)
  ),
  CHECK (
    (state = 'pending' AND accepted_at IS NULL AND revoked_at IS NULL
      AND accepted_membership_id IS NULL)
    OR
    (state = 'accepted' AND accepted_at IS NOT NULL AND revoked_at IS NULL
      AND accepted_membership_id IS NOT NULL)
    OR
    (state = 'revoked' AND accepted_at IS NULL AND revoked_at IS NOT NULL
      AND accepted_membership_id IS NULL)
  )
);

CREATE UNIQUE INDEX collection_invitations_pending_target_idx
  ON collection_invitations(collection_id, target_user_id)
  WHERE state = 'pending' AND target_user_id IS NOT NULL;

CREATE UNIQUE INDEX collection_invitations_pending_email_idx
  ON collection_invitations(collection_id, submitted_email)
  WHERE state = 'pending' AND target_mode = 'email';

CREATE INDEX collection_invitations_collection_idx
  ON collection_invitations(collection_id, state, created_at);

CREATE INDEX collection_invitations_target_idx
  ON collection_invitations(target_user_id, state, expires_at);

CREATE TABLE account_collection_member_seats (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL
    REFERENCES account_storage_accounts(user_id) ON DELETE CASCADE,
  membership_id uuid NOT NULL UNIQUE,
  collection_id uuid NOT NULL,
  member_user_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  FOREIGN KEY (membership_id, member_user_id, collection_id)
    REFERENCES collection_memberships(id, user_id, collection_id)
    ON DELETE CASCADE
);

CREATE INDEX account_collection_member_seats_active_owner_idx
  ON account_collection_member_seats(owner_user_id, consumed_at)
  WHERE released_at IS NULL;

INSERT INTO account_collection_member_seats
  (id, owner_user_id, membership_id, collection_id, member_user_id)
SELECT membership.id, identity.owner_user_id, membership.id,
       membership.collection_id, membership.user_id
FROM collection_memberships membership
JOIN collection_identities identity ON identity.id = membership.collection_id
JOIN account_storage_accounts account ON account.user_id = identity.owner_user_id
WHERE membership.revoked_at IS NULL
ON CONFLICT (membership_id) DO NOTHING;
