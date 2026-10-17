-- LAB fixture disposal: a retired migration route leaves the collection with no
-- hosted deployment, so the control plane stops waking and routing it to a
-- migration Worker that no longer serves it. Written only by the LAB-mounted
-- migration-token route; never cleared.
CREATE TABLE next_migration_routing_retirements (
  collection_id uuid PRIMARY KEY REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  actor text NOT NULL CHECK (actor <> ''),
  reason text NOT NULL CHECK (reason <> ''),
  retired_at timestamptz NOT NULL DEFAULT now()
);
