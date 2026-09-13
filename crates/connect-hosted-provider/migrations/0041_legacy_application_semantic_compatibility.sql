-- Preserve the checksums of migrations 0039/0040. Predecessor application
-- INSERTs omit both semantic metadata columns; only SQL NULL / SQL NULL is
-- compatible legacy authority. New writers continue to store explicit versions.
-- Deployment must fence new authorization through this migration: an interrupted
-- upgrade ending at 0040 is not an old-writer-compatible rollback endpoint.
ALTER TABLE hosted_provider_replicas
    DROP CONSTRAINT application_semantic_version_valid;
ALTER TABLE hosted_provider_replicas
    ADD CONSTRAINT application_semantic_version_valid CHECK (
        (purpose = 'application' AND (
            (application_semantic_version IS NULL AND application_setup_evidence IS NULL)
            OR (application_semantic_version IS NOT NULL AND (
                (application_semantic_version = 1 AND application_setup_evidence IS NULL)
                OR application_semantic_version = 2
            ))
        ))
        OR (purpose <> 'application' AND application_semantic_version IS NULL)
    );
-- Keep explicit v2 classification even for missing or malformed evidence. The
-- reader must reject invalid evidence; migration must never downgrade it to v1.
