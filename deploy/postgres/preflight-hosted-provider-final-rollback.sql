\set ON_ERROR_STOP on

\if :{?fence_kind}
\else
\set fence_kind rollback
\endif

-- Read-only compatibility gate before selecting an image whose source tree ends
-- at the consolidated Candidate B schema. Admission must already be suspended by
-- the rollback runner. This proves the exact migration ledger and the final
-- runtime objects the target expects; it never alters canonical or derived data.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = public, pg_catalog;
SELECT set_config('mdbase.admission_fence_token', :'fence_token', true);
SELECT set_config('mdbase.admission_fence_kind', :'fence_kind', true);

DO $final_rollback_preflight$
DECLARE
  migration_count bigint;
  minimum_version bigint;
  maximum_version bigint;
  failed_migrations bigint;
  missing_migrations bigint;
  runtime_rows bigint;
  invalid_states bigint;
  invalid_trigger_count bigint;
  unexpected_trigger_count bigint;
  invalid_function_count bigint;
  invalid_constraint_count bigint;
  runtime_constraint_count bigint;
  checksum_mismatches bigint[];
  missing_objects text[];
  missing_columns text[];
  missing_runtime_columns text[];
  requested_token uuid := current_setting('mdbase.admission_fence_token')::uuid;
  requested_kind text := current_setting('mdbase.admission_fence_kind');
BEGIN
  IF requested_kind NOT IN ('cutover', 'rollback') THEN
    RAISE EXCEPTION
      'final_schema_preflight_blocked: unsupported fence kind %', requested_kind;
  END IF;
  IF to_regclass('_sqlx_migrations') IS NULL THEN
    RAISE EXCEPTION
      'final_rollback_blocked: SQLx migration ledger is absent';
  END IF;

  SELECT count(*), min(version), max(version),
         count(*) FILTER (WHERE NOT success)
    INTO migration_count, minimum_version, maximum_version, failed_migrations
  FROM _sqlx_migrations;
  SELECT count(*)
    INTO missing_migrations
  FROM generate_series(1, 37) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1 FROM _sqlx_migrations applied
    WHERE applied.version = required.version AND applied.success
  );
  IF migration_count <> 37 OR minimum_version <> 1 OR maximum_version <> 37
     OR failed_migrations <> 0 OR missing_migrations <> 0 THEN
    RAISE EXCEPTION
      'final_rollback_blocked: expected exact successful final ledger 1-37';
  END IF;

  SELECT array_agg(expected.version ORDER BY expected.version)
    INTO checksum_mismatches
  FROM (VALUES
    (1, decode('4daf0bf53c91f53476028da0c761fc9d2056851faa90ba0feacc4216242fd7d99c1d81775f313715c0c3cffcf1499892', 'hex')),
    (2, decode('2c868421f2abb01b278464e8307c0e1d320f64a63e459799f5d815480830e0d6b1690748ce6b94fadbada2155bdc8d95', 'hex')),
    (3, decode('ec3c4db342567ed05e3d52578860c44568309cc61f66c5b158c6e5d92c6043b3a2c9cbc4a062b4220d106aa47317ca26', 'hex')),
    (4, decode('0fe88fe89cb947aef9dc4c46f06b6a845a1079a6990394a199711f6e39070cc5acc24c48d1fe342b4042376d02632d97', 'hex')),
    (5, decode('fbdcd6ba49268eaae1d27eae2651a3b60e7c5a9f79a2a550dd956467d6b19c05e00bc070d26ead7967e525487e63fbc6', 'hex')),
    (6, decode('8405faea8c7cf18f56645588f5b56a00c6f87821ec5ba8c57af52909d8bb6bed8ed066c3461d646df5e726624a4f14d9', 'hex')),
    (7, decode('fd41272bcc1803c527fa18029745e41475f5e64088c0104a60de5db26216c0ebebd7d3b0e07ce9d001b3615c344163ed', 'hex')),
    (8, decode('de5fc13ccdff9a8d7d5aafae779d7451c2f4ba6035a7b04e9d46f6a0618e7d659ec0be7a2e6a3985ef87de7645c726e7', 'hex')),
    (9, decode('26b4338b150bb621521b5a9ab3ba46632a5c570852352fdc816e2f102876127bd2510731360f5e7510fae45673003cc3', 'hex')),
    (10, decode('c3cbda51832b69357613ae6f9bf8f1ee6c8e635f78eb3da09ca92beadc3c662b4cc8d6639d9d0de935bcff774d4ff483', 'hex')),
    (11, decode('c2364d76df1bfbdefd55313a795162ec7906f99c1c61fb7f4543c85e2d24143425c4bf04a372befaa5f4992a8b669365', 'hex')),
    (12, decode('005b1bc92261dd1f8c94abd3a87f8e4a9770b0d80cbae2fc8e49a68d69e6118b7ebef3569140d9e2e6dc7b391763886f', 'hex')),
    (13, decode('a8bd70a32159f7b39cd7841d749edbb36ba3c6a16fffa4bf1e70199884b7c34f4f33c047091ae001001c4a1eccc9de67', 'hex')),
    (14, decode('e11cf1b0184d00b0786e66c32193210e32f683e7829716cc2b6baab74ba1f652e7535da31bb56d960179293bac72758c', 'hex')),
    (15, decode('c0bf69e779fc143b7c1cac1174126690e1e3aaa86e71a50ec752f8f54987c007ad7483065bf1baf3c2c3ba9e45b2d9b1', 'hex')),
    (16, decode('1759ea45667d10fca94af1685a498bdcb82468a3c289075ebb8e368e4972bb775650e9e42d3318eca8fd66ed23eaa397', 'hex')),
    (17, decode('041d1c92b07673d87a9611c0c40bbc6370122b551e8c3857b0519beb6c47488964149febe1a99aec13a423b7e9d6f87c', 'hex')),
    (18, decode('8c75b0988dd21267ada32cba958d6674fcc918723fdb4a41ff430daf92cbe8a507e41c7a5314db95c3c6ed93232a4f83', 'hex')),
    (19, decode('8398d21e875fd7a2e056ab13ffa92d7d966c0e85c890a249a780d9741c891bfb53616e53695df6193fb7580b8a060415', 'hex')),
    (20, decode('98a673990074029def794205117695cb5ec5d58494bae012e9b1f45040aee351fe1f658f6aca0242edc76cf38d25d718', 'hex')),
    (21, decode('e62a4479ad9624eb9393da0631566a334f20f0295a9b3571d5109af0ab5b0ed07f9021ee78067ef36fcedf496ac1cafd', 'hex')),
    (22, decode('f2267bd581669b9cb898651bdce49091c529d469e9120cbdb876e20ebd8b89b5f695e1c271841c5887a5e163d8a10933', 'hex')),
    (23, decode('039715ed447bd4549b9bb0feb31f5e707177ac03d4c6d825e6aa12e77f38abf3f670f5a35250e8230579477c5ba14f66', 'hex')),
    (24, decode('df495fca631ba6b5605cee7caffacba62842027a51a30b7dd1e18479716a9120f117998105dc927a1432f997ab966786', 'hex')),
    (25, decode('d53dc3d82667710ac3bb0067436005f194266448d5d55945ca303eb817fdd8d421801ff904c0922991df197cb719e684', 'hex')),
    (26, decode('cc5f9054affecdc909abc3df3768185c13a4d2296bc37be863bacdbe80a22aae067c4ab7a8526a5eee52dd383bdd1cc6', 'hex')),
    (27, decode('5c15c6510a7b3e6f7efa02ac916d292b430e4425f2e78658e701f7451af8a91dcf0d1b4c7ba69e01926eb93f4ddf319c', 'hex')),
    (28, decode('5814ab4c134d92c63071e4d58386d1c0017dfdafb62973e47997ab68c3409e869a1376a852f1200e4344e77c9fb64197', 'hex')),
    (29, decode('747d2e5216e6737be65a96ec5bc11d156e911b417ed10235b76d17c6922fa806537198c8a7745e6dce3c8c63fa51cc9b', 'hex')),
    (30, decode('4e0bac9195413ed058107713b3e9668d34ce235c95e1242b0889cc07aa07dcc6323dd4edc627f267defbf2383629f884', 'hex')),
    (31, decode('dfa5a545208c750163f7995430d501dc8fe30f08fffce6de74881e8a31c2b30adec883432849bf6c366868a81ea95096', 'hex')),
    (32, decode('d85c896ff2faa68c0c6c3925f2f6f9ae151f8a7b84f451bdb5e231ee223788eb5e3380a79b72cb1a7330ac954fc056d0', 'hex')),
    (33, decode('0ef8b9088494f0c8caebccd2b9df863a5697afb07b02f356d2ac50cbff846a4498fc74eb71cdc972bbb8aec1cdc2edae', 'hex')),
    (34, decode('ab662bb7a71e9f742cb197e6842a26b4526b74394b41ba2cc153644d5496a360960b7b6c9e01924ab56e45e7052dab37', 'hex')),
    (35, decode('042632e2b1ee010fabe5c23ae0ddc6aa91720aceafe21a263ca08a6b117a0638d0166c93deaf9dd565ba8eba32de3950', 'hex')),
    (36, decode('b3bf3e4d582211cf1df4a15806c5ae2715538aadd0fa6139aac580f4192ffa17668f4a07b34e0d9f34ca2a6a204f4bbb', 'hex')),
    (37, decode('0dba4741d39cc682c4d032f427b5fcad5517a0ce434b0ee580c5e6280a9cc0398d65889884520206900bb702110c829d', 'hex'))
  ) AS expected(version, checksum)
  LEFT JOIN _sqlx_migrations applied ON applied.version = expected.version
  WHERE applied.checksum IS DISTINCT FROM expected.checksum;
  IF checksum_mismatches IS NOT NULL THEN
    RAISE EXCEPTION
      'final_rollback_blocked: migration checksum mismatch at version(s) %',
      array_to_string(checksum_mismatches, ', ');
  END IF;

  SELECT array_agg(required.object_name ORDER BY required.object_name)
    INTO missing_objects
  FROM unnest(ARRAY[
    'hosted_provider_projection_generations',
    'hosted_provider_record_projections',
    'hosted_provider_record_resolution_keys',
    'hosted_provider_record_relationships',
    'hosted_provider_base_query_invocations',
    'hosted_provider_query_cursors',
    'hosted_provider_query_page_receipts',
    'hosted_provider_query_receipt_usage',
    'hosted_provider_runtime_control',
    'hosted_provider_collections_projection_backfill_idx',
    'hosted_provider_projection_generation_work_idx',
    'hosted_provider_record_projections_current_record_idx',
    'hosted_provider_record_projections_current_path_idx',
    'hosted_provider_record_projections_generation_idx',
    'hosted_provider_record_projections_snapshot_path_cursor_idx',
    'hosted_provider_record_projections_snapshot_mtime_cursor_idx',
    'hosted_provider_record_resolution_keys_lookup_idx',
    'hosted_provider_record_resolution_keys_current_idx',
    'hosted_provider_record_relationships_target_idx',
    'hosted_provider_record_relationships_unresolved_idx',
    'hosted_provider_record_relationships_current_idx',
    'hosted_provider_base_query_invocations_expiry_idx',
    'hosted_provider_base_query_invocations_collection_expiry_idx',
    'hosted_provider_query_cursors_expiry_idx',
    'hosted_provider_query_cursors_replica_idx',
    'hosted_provider_query_page_receipts_expiry_idx',
    'hosted_provider_query_page_receipts_global_expiry_idx'
  ]) AS required(object_name)
  WHERE to_regclass('public.' || required.object_name) IS NULL;
  IF missing_objects IS NOT NULL THEN
    RAISE EXCEPTION
      'final_rollback_blocked: required final relation/index objects are absent: %',
      array_to_string(missing_objects, ', ');
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO missing_columns
  FROM unnest(ARRAY[
    'active_catalog_revision',
    'active_projection_format_version',
    'active_semantic_engine_version',
    'active_projection_generation_id',
    'active_projection_head'
  ]) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns present
    WHERE present.table_schema = 'public'
      AND present.table_name = 'hosted_provider_collections'
      AND present.column_name = required.column_name
  );
  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'final_rollback_blocked: required collection binding columns are absent: %',
      array_to_string(missing_columns, ', ');
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.column_name)
    INTO missing_runtime_columns
  FROM unnest(ARRAY[
    'admission_fence_token',
    'admission_fence_kind',
    'admission_lease_expires_at'
  ]) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns present
    WHERE present.table_schema = 'public'
      AND present.table_name = 'hosted_provider_runtime_control'
      AND present.column_name = required.column_name
  );
  IF missing_runtime_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'final_rollback_blocked: required runtime control columns are absent: %',
      array_to_string(missing_runtime_columns, ', ');
  END IF;

  WITH expected(trigger_name, relation_name, function_name, trigger_definition) AS (
    VALUES
      ('hosted_provider_record_projection_digest_observer',
       'hosted_provider_record_projections', 'hosted_provider_observe_projection_digest',
       'CREATE TRIGGER hosted_provider_record_projection_digest_observer BEFORE INSERT OR UPDATE ON public.hosted_provider_record_projections FOR EACH ROW EXECUTE FUNCTION hosted_provider_observe_projection_digest()'),
      ('hosted_provider_projection_epoch_after_insert',
       'hosted_provider_record_projections', 'hosted_provider_bump_projection_epoch_after_insert',
       'CREATE TRIGGER hosted_provider_projection_epoch_after_insert AFTER INSERT ON public.hosted_provider_record_projections REFERENCING NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_insert()'),
      ('hosted_provider_projection_epoch_after_update',
       'hosted_provider_record_projections', 'hosted_provider_bump_projection_epoch_after_update',
       'CREATE TRIGGER hosted_provider_projection_epoch_after_update AFTER UPDATE ON public.hosted_provider_record_projections REFERENCING OLD TABLE AS old_projection_rows NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_update()'),
      ('hosted_provider_projection_epoch_after_delete',
       'hosted_provider_record_projections', 'hosted_provider_bump_projection_epoch_after_delete',
       'CREATE TRIGGER hosted_provider_projection_epoch_after_delete AFTER DELETE ON public.hosted_provider_record_projections REFERENCING OLD TABLE AS old_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_delete()'),
      ('hosted_provider_resolution_key_epoch_after_insert',
       'hosted_provider_record_resolution_keys', 'hosted_provider_bump_projection_epoch_after_insert',
       'CREATE TRIGGER hosted_provider_resolution_key_epoch_after_insert AFTER INSERT ON public.hosted_provider_record_resolution_keys REFERENCING NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_insert()'),
      ('hosted_provider_resolution_key_epoch_after_update',
       'hosted_provider_record_resolution_keys', 'hosted_provider_bump_projection_epoch_after_update',
       'CREATE TRIGGER hosted_provider_resolution_key_epoch_after_update AFTER UPDATE ON public.hosted_provider_record_resolution_keys REFERENCING OLD TABLE AS old_projection_rows NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_update()'),
      ('hosted_provider_resolution_key_epoch_after_delete',
       'hosted_provider_record_resolution_keys', 'hosted_provider_bump_projection_epoch_after_delete',
       'CREATE TRIGGER hosted_provider_resolution_key_epoch_after_delete AFTER DELETE ON public.hosted_provider_record_resolution_keys REFERENCING OLD TABLE AS old_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_delete()'),
      ('hosted_provider_relationship_epoch_after_insert',
       'hosted_provider_record_relationships', 'hosted_provider_bump_projection_epoch_after_insert',
       'CREATE TRIGGER hosted_provider_relationship_epoch_after_insert AFTER INSERT ON public.hosted_provider_record_relationships REFERENCING NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_insert()'),
      ('hosted_provider_relationship_epoch_after_update',
       'hosted_provider_record_relationships', 'hosted_provider_bump_projection_epoch_after_update',
       'CREATE TRIGGER hosted_provider_relationship_epoch_after_update AFTER UPDATE ON public.hosted_provider_record_relationships REFERENCING OLD TABLE AS old_projection_rows NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_update()'),
      ('hosted_provider_relationship_epoch_after_delete',
       'hosted_provider_record_relationships', 'hosted_provider_bump_projection_epoch_after_delete',
       'CREATE TRIGGER hosted_provider_relationship_epoch_after_delete AFTER DELETE ON public.hosted_provider_record_relationships REFERENCING OLD TABLE AS old_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_delete()')
  ), observed AS (
    SELECT trigger_row.tgname AS trigger_name,
           relation.relname AS relation_name,
           function_row.proname AS function_name,
           function_namespace.nspname AS function_schema,
           trigger_row.tgenabled,
           pg_get_triggerdef(trigger_row.oid, false) AS trigger_definition
    FROM pg_trigger trigger_row
    JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
    JOIN pg_namespace function_namespace
      ON function_namespace.oid = function_row.pronamespace
    WHERE namespace.nspname = 'public'
      AND NOT trigger_row.tgisinternal
  )
  SELECT count(*)
    INTO invalid_trigger_count
  FROM expected
  LEFT JOIN observed USING (trigger_name)
  WHERE observed.trigger_name IS NULL
     OR observed.relation_name IS DISTINCT FROM expected.relation_name
     OR observed.function_name IS DISTINCT FROM expected.function_name
     OR observed.function_schema IS DISTINCT FROM 'public'
     OR observed.tgenabled IS DISTINCT FROM 'O'
     OR observed.trigger_definition IS DISTINCT FROM expected.trigger_definition;
  IF invalid_trigger_count <> 0 THEN
    RAISE EXCEPTION
      'final_rollback_blocked: % final projection integrity trigger(s) differ from the exact contract',
      invalid_trigger_count;
  END IF;

  SELECT count(*)
    INTO unexpected_trigger_count
  FROM pg_trigger trigger_row
  JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname IN (
      'hosted_provider_record_projections',
      'hosted_provider_record_resolution_keys',
      'hosted_provider_record_relationships'
    )
    AND NOT trigger_row.tgisinternal;
  IF unexpected_trigger_count <> 10 THEN
    RAISE EXCEPTION
      'final_rollback_blocked: expected exactly ten non-internal projection integrity triggers, found %',
      unexpected_trigger_count;
  END IF;

  WITH expected(function_name, definition_sha256) AS (
    VALUES
      ('hosted_provider_bump_projection_epoch_after_delete',
       '8c490048878b2651f0bedf09ab0ebb923c0205afd7b1035fc37a7979be8664d3'),
      ('hosted_provider_bump_projection_epoch_after_insert',
       '83e9d899414d8e0b90dc291ede7da9596821a234785748249d8b267c95cc9d6a'),
      ('hosted_provider_bump_projection_epoch_after_update',
       '85a552d204eaaf2d37bf3dc14b386881fba82437f80e7f425ce6b7314dadd9e7'),
      ('hosted_provider_observe_projection_digest',
       'eb9eb156588bfe83a6a9577bb35b91b3a3439e6e9a89e037ee53e67fa14edb54')
  ), observed AS (
    SELECT function_row.proname AS function_name,
           encode(
             sha256(convert_to(pg_get_functiondef(function_row.oid), 'UTF8')),
             'hex'
           ) AS definition_sha256
    FROM pg_proc function_row
    JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
    WHERE namespace.nspname = 'public'
  )
  SELECT count(*)
    INTO invalid_function_count
  FROM expected
  LEFT JOIN observed USING (function_name)
  WHERE observed.function_name IS NULL
     OR observed.definition_sha256 IS DISTINCT FROM expected.definition_sha256;
  IF invalid_function_count <> 0 THEN
    RAISE EXCEPTION
      'final_rollback_blocked: % projection integrity function body/bodies differ from the exact contract',
      invalid_function_count;
  END IF;

  WITH expected(
    constraint_name, relation_name, constraint_type, is_deferrable,
    initially_deferred, constraint_definition
  ) AS (
    VALUES
      ('hosted_provider_collections_projection_binding_check',
       'hosted_provider_collections', 'c'::"char", false, false,
       'CHECK ((((active_catalog_revision IS NULL) AND (active_projection_format_version IS NULL) AND (active_semantic_engine_version IS NULL) AND (active_projection_generation_id IS NULL) AND (active_projection_head IS NULL)) OR ((active_catalog_revision IS NOT NULL) AND (active_projection_format_version > 0) AND (active_semantic_engine_version IS NOT NULL) AND (active_projection_generation_id IS NOT NULL) AND (active_projection_head IS NOT NULL))))'),
      ('hosted_provider_collections_active_projection_generation_fk',
       'hosted_provider_collections', 'f'::"char", true, true,
       'FOREIGN KEY (id, active_projection_generation_id) REFERENCES hosted_provider_projection_generations(collection_id, generation_id) DEFERRABLE INITIALLY DEFERRED'),
      ('hosted_provider_runtime_control_fence_kind_check',
       'hosted_provider_runtime_control', 'c'::"char", false, false,
       'CHECK (((admission_fence_kind IS NULL) OR (admission_fence_kind = ANY (ARRAY[''cutover''::text, ''rollback''::text]))))'),
      ('hosted_provider_runtime_control_fence_pair_check',
       'hosted_provider_runtime_control', 'c'::"char", false, false,
       'CHECK (((admission_fence_token IS NULL) = (admission_fence_kind IS NULL)))'),
      ('hosted_provider_runtime_control_fence_state_check',
       'hosted_provider_runtime_control', 'c'::"char", false, false,
       'CHECK ((query_admission_suspended OR (admission_fence_token IS NULL) OR (admission_lease_expires_at IS NOT NULL)))'),
      ('hosted_provider_runtime_control_lease_state_check',
       'hosted_provider_runtime_control', 'c'::"char", false, false,
       'CHECK (((admission_lease_expires_at IS NULL) OR ((NOT query_admission_suspended) AND (admission_fence_token IS NOT NULL) AND (admission_fence_kind = ''cutover''::text))))'),
      ('hosted_provider_runtime_control_pkey',
       'hosted_provider_runtime_control', 'p'::"char", false, false,
       'PRIMARY KEY (singleton)'),
      ('hosted_provider_runtime_control_singleton_check',
       'hosted_provider_runtime_control', 'c'::"char", false, false,
       'CHECK (singleton)'),
      ('hosted_provider_runtime_control_suspension_reason_check',
       'hosted_provider_runtime_control', 'c'::"char", false, false,
       'CHECK (((suspension_reason IS NULL) OR ((length(suspension_reason) >= 1) AND (length(suspension_reason) <= 512))))'),
      ('hosted_provider_runtime_control_check',
       'hosted_provider_runtime_control', 'c'::"char", false, false,
       'CHECK ((query_admission_suspended OR (suspension_reason IS NULL)))')
  ), observed AS (
    SELECT constraint_row.conname AS constraint_name,
           relation.relname AS relation_name,
           constraint_row.contype AS constraint_type,
           constraint_row.condeferrable AS is_deferrable,
           constraint_row.condeferred AS initially_deferred,
           constraint_row.convalidated,
           pg_get_constraintdef(constraint_row.oid, false) AS constraint_definition
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
  )
  SELECT count(*)
    INTO invalid_constraint_count
  FROM expected
  LEFT JOIN observed USING (constraint_name)
  WHERE observed.constraint_name IS NULL
     OR observed.relation_name IS DISTINCT FROM expected.relation_name
     OR observed.constraint_type IS DISTINCT FROM expected.constraint_type
     OR observed.is_deferrable IS DISTINCT FROM expected.is_deferrable
     OR observed.initially_deferred IS DISTINCT FROM expected.initially_deferred
     OR observed.convalidated IS DISTINCT FROM true
     OR observed.constraint_definition IS DISTINCT FROM expected.constraint_definition;
  IF invalid_constraint_count <> 0 THEN
    RAISE EXCEPTION
      'final_rollback_blocked: % final projection binding constraint(s) differ from the exact contract',
      invalid_constraint_count;
  END IF;

  SELECT count(*)
    INTO runtime_constraint_count
  FROM pg_constraint constraint_row
  JOIN pg_class relation ON relation.oid = constraint_row.conrelid
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'hosted_provider_runtime_control'
    AND constraint_row.contype IN ('c', 'p');
  IF runtime_constraint_count <> 8 THEN
    RAISE EXCEPTION
      'final_rollback_blocked: expected exactly eight runtime-control check/key constraints, found %',
      runtime_constraint_count;
  END IF;

  SELECT count(*)
    INTO runtime_rows
  FROM hosted_provider_runtime_control
  WHERE singleton = true
    AND query_admission_suspended = true
    AND suspension_reason = 'controlled_provider_' || requested_kind
    AND admission_fence_token = requested_token
    AND admission_fence_kind = requested_kind
    AND admission_lease_expires_at IS NULL;
  IF runtime_rows <> 1 OR (SELECT count(*) FROM hosted_provider_runtime_control) <> 1 THEN
    RAISE EXCEPTION
      'final_schema_preflight_blocked: expected exactly one matching controlled suspended admission row';
  END IF;

  SELECT count(*) INTO invalid_states
  FROM hosted_provider_collections
  WHERE state NOT IN (
    'active', 'indexing', 'importing', 'transferring', 'transferred', 'deleting'
  );
  IF invalid_states > 0 THEN
    RAISE EXCEPTION
      'final_rollback_blocked: % collection(s) use an unsupported lifecycle state',
      invalid_states;
  END IF;
END
$final_rollback_preflight$;

SELECT count(*) AS collections,
       count(*) FILTER (WHERE state = 'active') AS active_collections,
       count(*) FILTER (
         WHERE state = 'active' AND active_projection_generation_id IS NULL
       ) AS active_unbound_collections,
       count(*) FILTER (WHERE state = 'indexing') AS indexing_collections
FROM hosted_provider_collections;

COMMIT;

SELECT 'final_rollback_preflight_ready' AS result;
