-- mdbase:skip-if-missing-table push_channels
-- Push targets sealed at rest (AES-256-GCM). When a sealer is configured, new
-- registrations write sealed_target and leave the plaintext target columns NULL.
ALTER TABLE push_channels ADD COLUMN sealed_target text;
ALTER TABLE push_channels ADD COLUMN sealed_key_id text;
