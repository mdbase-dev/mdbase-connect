-- Local, non-replayable operations retain an owner until runtime settlement.
CREATE TABLE local_runtime_claims (
    collection_id TEXT NOT NULL,
    host_claim TEXT NOT NULL,
    PRIMARY KEY (collection_id, host_claim)
);

-- Explicit legacy recovery selections survive interruption and provide an audit.
CREATE TABLE runtime_claim_recoveries (
    collection_id TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    selected_at_ms INTEGER NOT NULL,
    completed_at_ms INTEGER,
    PRIMARY KEY (collection_id, commit_id)
);
