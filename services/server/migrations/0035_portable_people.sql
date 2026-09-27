-- Account-wide identifier disclosed to applications approved for People
-- access. It is deliberately separate from users.id: subjects are copied into
-- user-owned person notes, so internal keys must remain free to change.
-- A recreated account receives a new row and therefore a new subject.
ALTER TABLE users ADD COLUMN public_subject text;

UPDATE users
SET public_subject = 'acct_' || replace(gen_random_uuid()::text, '-', '')
WHERE public_subject IS NULL;

ALTER TABLE users
  ALTER COLUMN public_subject SET DEFAULT ('acct_' || replace(gen_random_uuid()::text, '-', ''));

ALTER TABLE users
  ALTER COLUMN public_subject SET NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_public_subject_key UNIQUE (public_subject);

-- People permissions the approving user actually granted: required ones plus
-- any chosen optional ones. NULL grants none, so existing grants disclose no
-- account metadata.
ALTER TABLE grants ADD COLUMN people_permissions jsonb;
