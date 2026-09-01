import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const container = `mdbase-file-adversarial-postgres-${process.pid}`;
const password = `postgres-${randomUUID()}`;

try {
  await execute("docker", [
    "run", "--rm", "-d", "--name", container,
    "-e", "POSTGRES_USER=mdbase",
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", "POSTGRES_DB=mdbase",
    "-p", "127.0.0.1::5432",
    "postgres:18-alpine"
  ], { cwd: root });
  const { stdout } = await execute("docker", ["port", container, "5432/tcp"], { cwd: root });
  const port = stdout.match(/:(\d+)/)?.[1];
  if (!port) throw new Error(`Could not determine PostgreSQL port from ${JSON.stringify(stdout)}`);
  await waitForPostgres();
  const databaseUrl = `postgres://mdbase:${password}@127.0.0.1:${port}/mdbase`;
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "operation_dispatch", "--", "--ignored", "--nocapture", "--test-threads=1"
  ], {
    MDBASE_PROJECTION_DATABASE_URL: databaseUrl,
    MDBASE_APPROVE_DESTRUCTIVE_HOSTED_TESTS: "operation_dispatch_uuid_schema_v1"
  });
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "file_lifecycle_adversarial", "--", "--ignored", "--nocapture"
  ], { MDBASE_ADVERSARIAL_DATABASE_URL: databaseUrl });
  const beta69Database = "mdbase_beta69_preflight";
  await execute(
    "docker",
    ["exec", container, "createdb", "-U", "mdbase", beta69Database],
    { cwd: root }
  );
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "projection_lifecycle",
    "candidate_b_beta69_cutover_preflight_fixture",
    "--", "--ignored", "--nocapture"
  ], {
    MDBASE_PROJECTION_DATABASE_URL:
      `postgres://mdbase:${password}@127.0.0.1:${port}/${beta69Database}`
  });
  await proveBeta69CutoverGate(beta69Database);
  const migrationDatabase = "mdbase_projection_migration";
  await execute(
    "docker",
    ["exec", container, "createdb", "-U", "mdbase", migrationDatabase],
    { cwd: root }
  );
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "projection_lifecycle",
    "candidate_b_consolidated_migrations_upgrade_the_beta69_schema",
    "--", "--ignored", "--nocapture"
  ], {
    MDBASE_PROJECTION_DATABASE_URL:
      `postgres://mdbase:${password}@127.0.0.1:${port}/${migrationDatabase}`
  });
  await proveFinalAdmissionAndRollbackGates(migrationDatabase);
  const collectionAuthorizationMigrationDatabase =
    "mdbase_collection_authorization_migration";
  await execute(
    "docker",
    [
      "exec", container, "createdb", "-U", "mdbase",
      collectionAuthorizationMigrationDatabase
    ],
    { cwd: root }
  );
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "projection_lifecycle",
    "collection_authorization_migration_does_not_resurrect_expired_tokens",
    "--", "--ignored", "--nocapture"
  ], {
    MDBASE_PROJECTION_DATABASE_URL:
      `postgres://mdbase:${password}@127.0.0.1:${port}/${collectionAuthorizationMigrationDatabase}`
  });
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "projection_lifecycle", "--", "--ignored", "--nocapture",
    "--test-threads=1",
    "--skip", "candidate_b_beta69_cutover_preflight_fixture",
    "--skip", "candidate_b_consolidated_migrations_upgrade_the_beta69_schema",
    "--skip", "collection_authorization_migration_does_not_resurrect_expired_tokens",
    "--skip", "candidate_b_projection_lifecycle_is_snapshot_safe_and_write_through",
    "--skip", "candidate_b_recovery_does_not_supersede_a_concurrent_explicit_generation_start",
    "--skip", "candidate_b_scalar_cursor_uses_canonical_collation_in_an_icu_database",
    "--skip", "candidate_b_base_candidate_prunes_100k_live_rows",
    "--skip", "candidate_b_exact_projected_filter_and_group_100k",
    "--skip", "candidate_b_exact_projected_filter_and_group_230k"
  ], { MDBASE_PROJECTION_DATABASE_URL: databaseUrl });
  for (const [index, testName] of [
    "candidate_b_projection_lifecycle_is_snapshot_safe_and_write_through",
    "candidate_b_recovery_does_not_supersede_a_concurrent_explicit_generation_start"
  ].entries()) {
    const isolatedDatabase = `mdbase_projection_isolated_${index}`;
    await execute(
      "docker",
      ["exec", container, "createdb", "-U", "mdbase", isolatedDatabase],
      { cwd: root }
    );
    await run("cargo", [
      "test", "-p", "mdbase-connect-hosted-provider",
      "--test", "projection_lifecycle", testName,
      "--", "--ignored", "--nocapture"
    ], {
      MDBASE_PROJECTION_DATABASE_URL:
        `postgres://mdbase:${password}@127.0.0.1:${port}/${isolatedDatabase}`
    });
  }
  const icuDatabase = "mdbase_projection_icu";
  await execute(
    "docker",
    ["exec", container, "createdb", "-U", "mdbase", "--template=template0",
      "--locale-provider=icu", "--icu-locale=en-US", icuDatabase],
    { cwd: root }
  );
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "projection_lifecycle",
    "candidate_b_scalar_cursor_uses_canonical_collation_in_an_icu_database",
    "--", "--ignored", "--nocapture"
  ], {
    MDBASE_PROJECTION_DATABASE_URL:
      `postgres://mdbase:${password}@127.0.0.1:${port}/${icuDatabase}`
  });
  for (const [index, testName] of [
    "candidate_b_base_candidate_prunes_100k_live_rows",
    "candidate_b_exact_projected_filter_and_group_100k",
    "candidate_b_exact_projected_filter_and_group_230k"
  ].entries()) {
    const largeDatabase = `mdbase_projection_large_${index}`;
    await execute(
      "docker",
      ["exec", container, "createdb", "-U", "mdbase", largeDatabase],
      { cwd: root }
    );
    await run("cargo", [
      "test", "-p", "mdbase-connect-hosted-provider",
      "--test", "projection_lifecycle", testName,
      "--", "--ignored", "--nocapture"
    ], {
      MDBASE_HOSTED_EXECUTION_TEST_ENTITLEMENT: "large_fixture_v1",
      MDBASE_PROJECTION_DATABASE_URL:
        `postgres://mdbase:${password}@127.0.0.1:${port}/${largeDatabase}`
    });
  }
} finally {
  await execute("docker", ["stop", container], { cwd: root }).catch(() => {});
}

async function waitForPostgres() {
  // The image briefly starts an initialization server before restarting into
  // the final TCP-serving process. Require consecutive ready samples so tests
  // cannot race that restart and receive a connection reset.
  let consecutiveReady = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await execute(
      "docker",
      ["exec", container, "pg_isready", "-U", "mdbase"],
      { cwd: root }
    ).then(() => true, () => false);
    consecutiveReady = ready ? consecutiveReady + 1 : 0;
    if (consecutiveReady === 4) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error("PostgreSQL did not remain ready within 30 seconds");
}

async function proveFinalAdmissionAndRollbackGates(database) {
  const token = "12345678-1234-4234-8234-123456789abc";
  const wrongToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rollbackPair = {
    predecessor_migration: "37",
    candidate_migration: "38"
  };
  const scripts = {
    suspend: "deploy/postgres/suspend-hosted-query-admission.sql",
    resume: "deploy/postgres/resume-hosted-query-admission.sql",
    finalPreflight: "deploy/postgres/preflight-hosted-provider-final-rollback.sql",
    finalCutover: "deploy/postgres/preflight-hosted-provider-final-cutover.sql",
    "preflight-hosted-provider-final-rollback":
      "deploy/postgres/preflight-hosted-provider-final-rollback.sql",
    beta69Rollback: "deploy/postgres/prepare-hosted-provider-beta69-rollback.sql",
    "attest-hosted-provider-migration-ledger":
      "deploy/postgres/attest-hosted-provider-migration-ledger.sql",
    databaseDrained: "deploy/postgres/preflight-hosted-database-drained.sql"
  };
  for (const [name, source] of Object.entries(scripts)) {
    await execute("docker", [
      "cp", resolve(root, source), `${container}:/tmp/${name}.sql`
    ], { cwd: root });
  }
  const drainObserver = "mdbase_drain_observer";
  await psql(database, `CREATE ROLE ${drainObserver} LOGIN`);
  await psqlFileAs(database, "databaseDrained", drainObserver);
  const drainBlockerApplication = "mdbase-drain-contract-test";
  const drainBlocker = spawn("docker", [
    "exec", "-e", `PGAPPNAME=${drainBlockerApplication}`, container,
    "psql", "-U", "mdbase", "-d", database, "--no-psqlrc",
    "--command", "SELECT pg_sleep(30)"
  ], { cwd: root, stdio: "ignore" });
  await waitForApplicationSession(database, drainBlockerApplication);
  await expectPsqlFileAsFailure(
    database,
    "databaseDrained",
    drainObserver,
    "the drain preflight accepted another database session"
  );
  await psql(
    database,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${drainBlockerApplication}'`
  );
  await waitForChildExit(drainBlocker);
  await psqlFile(database, "databaseDrained");
  await psqlFile(database, "suspend", {
    fence_token: token,
    fence_kind: "rollback",
    owner_lease_seconds: "7200"
  });
  await psqlFile(database, "finalPreflight", {
    ...rollbackPair,
    fence_token: token
  });
  await expectPsqlFailure(
    database,
    "resume",
    { fence_token: wrongToken, fence_kind: "rollback" },
    "a stale fence token resumed hosted admission"
  );
  await expectPsqlFailure(
    database,
    "resume",
    { fence_token: token, fence_kind: "cutover" },
    "a mismatched fence kind resumed hosted admission"
  );
  await psql(database,
    "ALTER TABLE hosted_provider_record_relationships DISABLE TRIGGER hosted_provider_relationship_epoch_after_insert");
  await expectPsqlFailure(
    database,
    "finalPreflight",
    { ...rollbackPair, fence_token: token },
    "the final preflight accepted a disabled integrity trigger"
  );
  await psql(database,
    "ALTER TABLE hosted_provider_record_relationships ENABLE TRIGGER hosted_provider_relationship_epoch_after_insert");
  await psql(database,
    "CREATE TRIGGER hosted_provider_unexpected_integrity_trigger AFTER INSERT ON hosted_provider_record_relationships REFERENCING NEW TABLE AS new_projection_rows FOR EACH STATEMENT EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_insert()");
  await expectPsqlFailure(
    database,
    "finalPreflight",
    { ...rollbackPair, fence_token: token },
    "the final preflight accepted an unexpected derived-state trigger"
  );
  await psql(database,
    "DROP TRIGGER hosted_provider_unexpected_integrity_trigger ON hosted_provider_record_relationships");
  await psql(database,
    "CREATE TABLE hosted_attestation_function_backup (definition text NOT NULL); INSERT INTO hosted_attestation_function_backup SELECT pg_get_functiondef('hosted_provider_bump_projection_epoch_after_insert()'::regprocedure); CREATE OR REPLACE FUNCTION hosted_provider_bump_projection_epoch_after_insert() RETURNS trigger LANGUAGE plpgsql AS $altered$ BEGIN RETURN NULL; END $altered$");
  await expectPsqlFailure(
    database,
    "finalPreflight",
    { ...rollbackPair, fence_token: token },
    "the final preflight accepted an altered integrity function body"
  );
  await psql(database,
    "DO $restore$ DECLARE saved_definition text; BEGIN SELECT definition INTO saved_definition FROM hosted_attestation_function_backup; EXECUTE saved_definition; END $restore$; DROP TABLE hosted_attestation_function_backup");
  await psql(database,
    "ALTER TABLE hosted_provider_collections RENAME CONSTRAINT hosted_provider_collections_projection_binding_check TO hosted_provider_collections_projection_binding_check_wrong");
  await expectPsqlFailure(
    database,
    "finalPreflight",
    { ...rollbackPair, fence_token: token },
    "the final preflight accepted a renamed binding constraint"
  );
  await psql(database,
    "ALTER TABLE hosted_provider_collections RENAME CONSTRAINT hosted_provider_collections_projection_binding_check_wrong TO hosted_provider_collections_projection_binding_check");
  await psql(database,
    "ALTER TABLE hosted_provider_runtime_control RENAME CONSTRAINT hosted_provider_runtime_control_fence_pair_check TO hosted_provider_runtime_control_fence_pair_check_wrong");
  await expectPsqlFailure(
    database,
    "finalPreflight",
    { ...rollbackPair, fence_token: token },
    "the final preflight accepted a renamed admission-fence constraint"
  );
  await psql(database,
    "ALTER TABLE hosted_provider_runtime_control RENAME CONSTRAINT hosted_provider_runtime_control_fence_pair_check_wrong TO hosted_provider_runtime_control_fence_pair_check");
  await psqlFile(database, "resume", { fence_token: token, fence_kind: "rollback" });
  await psqlFile(database, "suspend", {
    fence_token: token,
    fence_kind: "cutover",
    owner_lease_seconds: "7200"
  });
  await expectPsqlFailure(
    database,
    "finalCutover",
    { ...rollbackPair, fence_token: token },
    "the retired Candidate B cutover accepted the migration 38 ledger"
  );
  await expectPsqlFailure(
    database,
    "finalCutover",
    { ...rollbackPair, fence_token: wrongToken },
    "the final cutover preflight accepted a stale fence token"
  );
  await psqlFile(database, "resume", { fence_token: token, fence_kind: "cutover" });
  await psqlFile(database, "suspend", {
    fence_token: token,
    fence_kind: "rollback",
    owner_lease_seconds: "7200"
  });
  await expectPsqlFailure(
    database,
    "beta69Rollback",
    { fence_token: token },
    "the retired beta69 rollback accepted the migration 38 ledger"
  );
  await psqlFile(database, "resume", { fence_token: token, fence_kind: "rollback" });
}

async function proveBeta69CutoverGate(database) {
  for (const [name, source] of Object.entries({
    beta69Preflight: "deploy/postgres/preflight-hosted-provider-beta69-cutover.sql",
    "attest-hosted-provider-migration-ledger":
      "deploy/postgres/attest-hosted-provider-migration-ledger.sql"
  })) {
    await execute("docker", [
      "cp", resolve(root, source), `${container}:/tmp/${name}.sql`
    ], { cwd: root });
  }
  await psqlFile(database, "beta69Preflight");
  await psql(database,
    "UPDATE _sqlx_migrations SET checksum = decode(repeat('00', 48), 'hex') WHERE version = 34");
  await expectPsqlFailure(
    database,
    "beta69Preflight",
    {},
    "the beta69 cutover preflight accepted a corrupted migration checksum"
  );
}

async function psqlFile(database, name, variables = {}) {
  const args = [
    "exec", container, "psql", "-U", "mdbase", "-d", database,
    "--no-psqlrc", "--set", "ON_ERROR_STOP=on"
  ];
  for (const [key, value] of Object.entries(variables)) {
    args.push("--set", `${key}=${value}`);
  }
  args.push("--file", `/tmp/${name}.sql`);
  await execute("docker", args, { cwd: root });
}

async function psqlFileAs(database, name, role) {
  await execute("docker", [
    "exec", container, "psql", "-U", role, "-d", database,
    "--no-psqlrc", "--set", "ON_ERROR_STOP=on", "--file", `/tmp/${name}.sql`
  ], { cwd: root });
}

async function expectPsqlFileAsFailure(database, name, role, message) {
  const failed = await psqlFileAs(database, name, role).then(
    () => false,
    () => true
  );
  if (!failed) throw new Error(message);
}

async function waitForApplicationSession(database, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { stdout } = await execute("docker", [
      "exec", container, "psql", "-U", "mdbase", "-d", database,
      "--no-psqlrc", "--tuples-only", "--no-align", "--command",
      `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${applicationName}'`
    ], { cwd: root });
    if (stdout.trim() === "1") return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Database session ${applicationName} did not start`);
}

function waitForChildExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
}

async function expectPsqlFailure(database, name, variables, message) {
  const failed = await psqlFile(database, name, variables).then(
    () => false,
    () => true
  );
  if (!failed) throw new Error(message);
}

async function psql(database, statement) {
  await execute("docker", [
    "exec", container, "psql", "-U", "mdbase", "-d", database,
    "--no-psqlrc", "--set", "ON_ERROR_STOP=on", "--command", statement
  ], { cwd: root });
}

function run(command, args, extraEnvironment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}
