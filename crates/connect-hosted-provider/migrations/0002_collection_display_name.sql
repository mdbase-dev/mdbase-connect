ALTER TABLE hosted_provider_collections
ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT 'Hosted collection';
