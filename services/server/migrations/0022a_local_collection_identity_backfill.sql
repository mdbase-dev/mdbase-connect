-- mdbase:skip-if-missing-table collections
-- Local-only collections use collections.local_id as the same stable logical
-- identity used by hosted collections. Historical authority candidates for one
-- logical collection normally share an owner; any mismatch fails closed when
-- policy is resolved against the current authority owner.

INSERT INTO collection_identities (id, owner_user_id)
SELECT DISTINCT local_id, user_id FROM collections
ON CONFLICT (id) DO NOTHING;
