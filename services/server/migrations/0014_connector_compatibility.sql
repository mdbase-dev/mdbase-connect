ALTER TABLE connectors
  ADD COLUMN connector_version text,
  ADD COLUMN last_incompatible_at timestamptz,
  ADD COLUMN incompatibility_code text,
  ADD COLUMN minimum_connector_version text,
  ADD COLUMN connector_update_url text,
  ADD CONSTRAINT connectors_compatibility_state_complete CHECK (
    incompatibility_code IS NULL
    OR (
      last_incompatible_at IS NOT NULL
      AND minimum_connector_version IS NOT NULL
      AND connector_update_url IS NOT NULL
    )
  );
