-- Retain authenticated-feed consent metadata; no account reconstruction/backfill.
ALTER TABLE grants ADD COLUMN account_id TEXT
CHECK (account_id IS NULL OR (
    length(account_id) = 36
    AND substr(account_id, 9, 1) = '-'
    AND substr(account_id, 14, 1) = '-'
    AND substr(account_id, 19, 1) = '-'
    AND substr(account_id, 24, 1) = '-'
    AND length(replace(account_id, '-', '')) = 32
    AND replace(account_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    AND account_id <> '00000000-0000-0000-0000-000000000000'
));
