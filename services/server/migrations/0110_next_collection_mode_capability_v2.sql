-- Dedicated v2 capability column so predecessor servers still writing
-- mode_switch_advertised during deploy cannot satisfy v2 arming. The legacy
-- column stays until a later removal migration (docs/control-plane-migrations.md).
ALTER TABLE next_devices
  ADD COLUMN mode_switch_v2_advertised boolean NOT NULL DEFAULT false;

-- Cumulative bounded scan progress and first observed post-policy rekey
-- sequence on mode-change rows (abandoned Private switch resolution and
-- /abandon late-rekey refusal).
ALTER TABLE next_collection_mode_changes
  ADD COLUMN abandon_scanned_seq bigint,
  ADD COLUMN abandon_rekey_seq bigint;
ALTER TABLE next_collection_mode_changes
  ADD CONSTRAINT next_mode_abandon_scan_seq CHECK (
    (abandon_scanned_seq IS NULL OR abandon_scanned_seq > 1) AND
    (abandon_rekey_seq IS NULL OR abandon_rekey_seq > 1)
  );
