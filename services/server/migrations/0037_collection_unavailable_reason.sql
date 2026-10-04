-- mdbase:skip-if-missing-table collections
-- Why a connector reports a local collection unavailable, beyond the user's
-- own pause. NULL means no reason was reported, as from older connectors.
ALTER TABLE collections ADD COLUMN unavailable_reason text
  CHECK (unavailable_reason IS NULL OR unavailable_reason IN ('claimed_by_newer_runtime'));
