-- Complete normalized JSON evidence, never independent grant authority.
ALTER TABLE grants ADD COLUMN application_declaration TEXT;
ALTER TABLE revoked_grant_replay_material ADD COLUMN application_declaration TEXT;
