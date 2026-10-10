DROP TABLE legacy_encrypted_operation_receipts;
DROP TABLE revoked_grant_replay_material;
DROP TABLE mutation_journal_tombstones;
DROP TABLE mutation_journal;
DROP TABLE grant_crypto_requests;
DROP TABLE grant_crypto_state;
DROP TABLE grants;

DELETE FROM settings WHERE key = 'access_paused';
