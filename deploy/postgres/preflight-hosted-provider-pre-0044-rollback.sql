\set ON_ERROR_STOP on

-- A provider predating migration 0044 writes the semantic digest into the
-- expected row-integrity field. It is compatible only after query admission is
-- fenced and every collection has returned to encrypted-exact legacy execution.
DO $candidate_b_pre_0044_rollback_preflight$
DECLARE
  admission_suspended boolean;
  active_candidate_b_collections bigint;
  building_generations bigint;
BEGIN
  SELECT query_admission_suspended
    INTO admission_suspended
  FROM hosted_provider_runtime_control
  WHERE singleton = true;
  IF admission_suspended IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'candidate_b_pre_0044_rollback_blocked: suspend hosted query admission first';
  END IF;

  SELECT count(*) INTO active_candidate_b_collections
  FROM hosted_provider_collections
  WHERE state = 'active' AND hosted_execution_model = 'candidate_b';
  SELECT count(*) INTO building_generations
  FROM hosted_provider_projection_generations
  WHERE status = 'building';
  IF active_candidate_b_collections > 0 OR building_generations > 0 THEN
    RAISE EXCEPTION
      'candidate_b_pre_0044_rollback_blocked: % active Candidate B collection(s), % building generation(s); deactivate them through the reviewed rollback procedure first',
      active_candidate_b_collections, building_generations;
  END IF;
END
$candidate_b_pre_0044_rollback_preflight$;

SELECT 'candidate_b_pre_0044_rollback_ready' AS result;
