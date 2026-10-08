-- Permanent denial facts, deliberately outside every user/collection FK cascade.
-- CP intent and independently observed nil-registry floors are separate evidence.
-- These rows are not native Gone receipts or permissions to serve.
CREATE TABLE next_collection_deletion_facts (
  collection_id uuid NOT NULL CHECK (collection_id <> '00000000-0000-0000-0000-000000000000'),
  deletion_id uuid NOT NULL CHECK (deletion_id <> '00000000-0000-0000-0000-000000000000'),
  lifecycle_epoch numeric(20,0) NOT NULL CHECK (lifecycle_epoch > 0 AND lifecycle_epoch <= 18446744073709551615),
  authority text NOT NULL CHECK (authority IN ('cp-intent','native-registry')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  PRIMARY KEY (collection_id,deletion_id,lifecycle_epoch,authority)
);
-- One CP-selected intent ever; independent native facts can only add denial.
CREATE UNIQUE INDEX next_collection_deletion_first_intent
  ON next_collection_deletion_facts(collection_id) WHERE authority='cp-intent';
