-- Historical application capabilities retain only the predecessor's ID/digest
-- setup binding semantics. Never infer their version from operation payloads.
ALTER TABLE hosted_provider_replicas ADD COLUMN application_semantic_version integer;
-- Evidence-bearing rows were provisioned by the v2 evidence release. Preserve
-- their stronger admission even if stored evidence is malformed: dispatch must
-- reject it rather than silently fall back to predecessor semantics.
UPDATE hosted_provider_replicas SET application_semantic_version =
    CASE WHEN application_setup_evidence IS NULL THEN 1 ELSE 2 END
WHERE purpose = 'application';
ALTER TABLE hosted_provider_replicas ADD CONSTRAINT application_semantic_version_valid
CHECK ((purpose = 'application' AND application_semantic_version IS NOT NULL
        AND application_semantic_version IN (1, 2))
    OR (purpose <> 'application' AND application_semantic_version IS NULL));
