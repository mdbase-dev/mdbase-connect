-- mdbase:skip-if-missing-table applications
-- Historical split columns cannot reconstruct the digest-bound declaration.
-- Leave existing registrations unknown until a complete declaration is registered.
ALTER TABLE applications ADD COLUMN application_declaration jsonb;
