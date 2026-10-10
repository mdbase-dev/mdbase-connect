CREATE TABLE mutation_journal (
    application_installation_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL,
    input_schema_version INTEGER NOT NULL CHECK (input_schema_version > 0),
    input_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'claimed', 'prepared', 'applied', 'completed', 'acknowledged',
        'abandoned', 'outcome_unknown'
    )),
    process_epoch TEXT NOT NULL,
    lease_owner TEXT NOT NULL,
    lease_expires_at_ms INTEGER NOT NULL,
    fencing_generation INTEGER NOT NULL CHECK (fencing_generation > 0),
    prepared_data TEXT,
    before_evidence TEXT,
    after_evidence TEXT,
    result_metadata TEXT,
    final_receipt TEXT,
    receipt_digest TEXT,
    grant_snapshot_digest TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    acknowledged_at_ms INTEGER,
    compacted_at_ms INTEGER,
    PRIMARY KEY (application_installation_id, grant_id, request_id),
    CHECK (
        (state IN ('completed', 'acknowledged', 'abandoned', 'outcome_unknown')
            AND final_receipt IS NOT NULL AND receipt_digest IS NOT NULL
            AND completed_at_ms IS NOT NULL)
        OR
        (state IN ('claimed', 'prepared', 'applied')
            AND final_receipt IS NULL AND receipt_digest IS NULL
            AND completed_at_ms IS NULL)
    ),
    CHECK ((state = 'acknowledged') = (acknowledged_at_ms IS NOT NULL)),
    CHECK (compacted_at_ms IS NULL)
);

CREATE INDEX mutation_journal_state_age_idx
    ON mutation_journal(state, updated_at_ms);
CREATE INDEX mutation_journal_lease_idx
    ON mutation_journal(state, process_epoch, lease_expires_at_ms);

CREATE TABLE mutation_journal_tombstones (
    application_installation_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL,
    input_schema_version INTEGER NOT NULL CHECK (input_schema_version > 0),
    input_digest TEXT NOT NULL,
    terminal_state TEXT NOT NULL CHECK (terminal_state IN (
        'completed', 'acknowledged', 'abandoned', 'outcome_unknown'
    )),
    receipt_digest TEXT NOT NULL,
    accepted_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER NOT NULL,
    tombstoned_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY (application_installation_id, grant_id, request_id),
    CHECK (expires_at_ms > tombstoned_at_ms)
);

CREATE INDEX mutation_journal_tombstone_expiry_idx
    ON mutation_journal_tombstones(expires_at_ms);

-- Public verification and agreement material retained only to authenticate an
-- already-accepted request after revocation or key rotation. It never grants a
-- new request and is keyed by the exact historical encryption key.
CREATE TABLE revoked_grant_replay_material (
    grant_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    collection_id TEXT NOT NULL,
    operations TEXT NOT NULL,
    scope TEXT NOT NULL,
    application_name TEXT NOT NULL,
    application_distribution TEXT NOT NULL,
    application_homepage TEXT NOT NULL,
    application_project_url TEXT,
    application_origin TEXT NOT NULL,
    application_icon TEXT,
    collection_name TEXT NOT NULL,
    notification_criteria TEXT NOT NULL,
    created_at TEXT NOT NULL,
    encryption TEXT NOT NULL,
    file_capability TEXT,
    application_authorization TEXT NOT NULL,
    revoked_at_ms INTEGER NOT NULL,
    PRIMARY KEY (grant_id, key_id)
);

-- beta.28 encrypted receipts are retained losslessly for support/forensics but
-- are not a second runtime replay path: their fingerprint covered the transport
-- envelope rather than the canonical semantic mutation input.
CREATE TABLE legacy_encrypted_operation_receipts (
    grant_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_counter TEXT NOT NULL,
    legacy_request_fingerprint TEXT NOT NULL,
    response_envelope TEXT NOT NULL,
    received_at TEXT NOT NULL,
    archived_at_ms INTEGER NOT NULL,
    PRIMARY KEY (grant_id, key_id, request_id)
);

INSERT INTO legacy_encrypted_operation_receipts (
    grant_id, key_id, request_id, request_counter,
    legacy_request_fingerprint, response_envelope, received_at, archived_at_ms
)
SELECT grant_id, key_id, request_id, request_counter,
       request_fingerprint, response_envelope, received_at,
       CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM grant_crypto_requests
WHERE response_envelope IS NOT NULL;
