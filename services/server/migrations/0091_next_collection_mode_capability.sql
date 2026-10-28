-- Device advertisement is historical; token issuance uses the CURRENT request's
-- capabilities, never this bit. A collection's raised floor survives round trips.
ALTER TABLE next_devices ADD COLUMN mode_switch_advertised boolean NOT NULL DEFAULT false;
ALTER TABLE next_collections ADD COLUMN mode_floor_raised_at timestamptz;
