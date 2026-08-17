-- Included inside an existing transaction after the caller sets
-- mdbase.expected_migration_max to either the beta69 baseline (34) or the
-- final Candidate B schema (37).
DO $hosted_migration_ledger_attestation$
DECLARE
  expected_max bigint := current_setting('mdbase.expected_migration_max')::bigint;
  migration_count bigint;
  minimum_version bigint;
  maximum_version bigint;
  failed_migrations bigint;
  missing_migrations bigint;
  checksum_mismatches bigint[];
BEGIN
  IF expected_max NOT IN (34, 37) THEN
    RAISE EXCEPTION
      'hosted_migration_ledger_blocked: unsupported expected migration %', expected_max;
  END IF;
  IF to_regclass('public._sqlx_migrations') IS NULL THEN
    RAISE EXCEPTION
      'hosted_migration_ledger_blocked: SQLx migration ledger is absent';
  END IF;

  SELECT count(*), min(version), max(version),
         count(*) FILTER (WHERE NOT success)
    INTO migration_count, minimum_version, maximum_version, failed_migrations
  FROM public._sqlx_migrations;
  SELECT count(*)
    INTO missing_migrations
  FROM generate_series(1, expected_max) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1 FROM public._sqlx_migrations applied
    WHERE applied.version = required.version AND applied.success
  );
  IF migration_count <> expected_max OR minimum_version <> 1
     OR maximum_version <> expected_max OR failed_migrations <> 0
     OR missing_migrations <> 0 THEN
    RAISE EXCEPTION
      'hosted_migration_ledger_blocked: expected exact successful ledger 1-%',
      expected_max;
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
    (37, decode('d159baacd7a8c3e5168d01199ed0dc9d084583c571210943e13be8aa03795e33a4bd09e35231f4ad7d2801811ef16047', 'hex'))
  ) AS expected(version, checksum)
  LEFT JOIN public._sqlx_migrations applied ON applied.version = expected.version
  WHERE expected.version <= expected_max
    AND applied.checksum IS DISTINCT FROM expected.checksum;
  IF checksum_mismatches IS NOT NULL THEN
    RAISE EXCEPTION
      'hosted_migration_ledger_blocked: migration checksum mismatch at version(s) %',
      array_to_string(checksum_mismatches, ', ');
  END IF;
END
$hosted_migration_ledger_attestation$;
