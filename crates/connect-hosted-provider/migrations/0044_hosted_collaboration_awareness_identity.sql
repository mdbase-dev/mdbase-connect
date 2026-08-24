-- Awareness presentation identity for application replicas.
--
-- Collaboration presence needs a server-authoritative display identity. The
-- control plane derives {name, color} from the authenticated user (never the
-- email, never client input) and passes it through replica registration and
-- policy updates; this migration adds the bounded storage columns.
--
-- Expand-and-contract: nullable columns first, then a safe backfill of every
-- existing row, then shape constraints. The constraints keep every ordinary
-- non-collaboration path -- including replicas written by binaries that
-- predate this migration -- valid, so application rollback never requires
-- schema rollback. A collaboration capability without an identity is
-- rejected at the database as well as at registration time.
ALTER TABLE hosted_provider_replicas
  ADD COLUMN awareness_name text,
  ADD COLUMN awareness_color text;

-- Backfill existing rows with the safe bounded generic identity. It carries
-- no user, replica, grant, session, account, or record identifier. Ordinary
-- non-collaboration replicas keep it harmlessly; collaboration rows rely on
-- the application layer to replace it with the derived user identity at
-- their next registration or policy update.
UPDATE hosted_provider_replicas
SET awareness_name = 'Participant',
    awareness_color = 'slate'
WHERE awareness_name IS NULL OR awareness_color IS NULL;

ALTER TABLE hosted_provider_replicas
  ALTER COLUMN awareness_name SET DEFAULT 'Participant',
  ALTER COLUMN awareness_color SET DEFAULT 'slate';

ALTER TABLE hosted_provider_replicas
  ADD CONSTRAINT hosted_provider_replicas_awareness_name_check
  CHECK (
    awareness_name IS NULL
    OR (
      char_length(awareness_name) BETWEEN 1 AND 100
      AND octet_length(awareness_name) <= 400
      AND awareness_name = btrim(awareness_name)
    )
  ),
  ADD CONSTRAINT hosted_provider_replicas_awareness_color_check
  CHECK (
    awareness_color IS NULL
    OR awareness_color IN
      ('blue', 'teal', 'green', 'amber', 'orange', 'rose', 'violet', 'slate')
  ),
  ADD CONSTRAINT hosted_provider_replicas_collab_awareness_identity_check
  CHECK (
    collaboration_capability IS NULL
    OR (awareness_name IS NOT NULL AND awareness_color IS NOT NULL)
  );
