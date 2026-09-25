-- mdbase:skip-if-missing-table collections
-- Local collection registration time for the operator usage report. Existing
-- rows stay NULL: their registration time was never recorded, and stamping them
-- with the migration time would fabricate a cohort.
ALTER TABLE collections ADD COLUMN created_at timestamptz;
ALTER TABLE collections ALTER COLUMN created_at SET DEFAULT now();
