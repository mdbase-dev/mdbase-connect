-- When a synced collection leaves sync (turned off, downgrade, account deletion), the
-- control plane marks it here first, so the directory stops reporting it as
-- standard or private at once (mdbase-next docs/ship/control-plane.md §4.1). Nullable
-- column on a table the previous release never reads.
ALTER TABLE next_collections ADD COLUMN left_sync_at timestamptz;
