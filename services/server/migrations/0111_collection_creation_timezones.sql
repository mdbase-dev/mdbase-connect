-- A browser can fail to report a zone. Preserve that result on the original
-- intent, and leave historical pairing creations as they were.
ALTER TABLE account_collection_creations ALTER COLUMN timezone DROP NOT NULL;
ALTER TABLE installation_pairing_collection_creations ADD COLUMN timezone text;
ALTER TABLE account_onboarding ALTER COLUMN timezone DROP NOT NULL;
