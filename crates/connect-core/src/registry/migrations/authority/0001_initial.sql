CREATE TABLE authority_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
);

CREATE TABLE policy_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision TEXT NOT NULL,
    epoch INTEGER NOT NULL CHECK (epoch > 0),
    applied_at_ms INTEGER NOT NULL
);

CREATE TABLE authority_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE collection_access_overlays (
    collection_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE grants (
    id TEXT PRIMARY KEY,
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
    encryption TEXT,
    file_capability TEXT,
    application_authorization TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE grant_crypto_state (
    grant_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    last_request_counter TEXT NOT NULL,
    reorder_floor TEXT NOT NULL DEFAULT '0',
    PRIMARY KEY (grant_id, key_id)
);

CREATE TABLE grant_crypto_requests (
    grant_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_counter TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    replay_class TEXT NOT NULL CHECK (replay_class IN ('read', 'mutation')),
    process_epoch TEXT NOT NULL,
    received_at_ms INTEGER NOT NULL,
    PRIMARY KEY (grant_id, key_id, request_id)
);

CREATE UNIQUE INDEX grant_crypto_requests_request_counter
    ON grant_crypto_requests (grant_id, key_id, request_counter);
CREATE INDEX grant_crypto_requests_read_retention
    ON grant_crypto_requests (grant_id, key_id, replay_class, received_at_ms);

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
