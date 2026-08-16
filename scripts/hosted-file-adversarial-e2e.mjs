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
    "--test", "file_lifecycle_adversarial", "--", "--ignored", "--nocapture"
  ], { MDBASE_ADVERSARIAL_DATABASE_URL: databaseUrl });
  const migrationDatabase = "mdbase_projection_migration";
  await execute(
    "docker",
    ["exec", container, "createdb", "-U", "mdbase", migrationDatabase],
    { cwd: root }
  );
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "projection_lifecycle",
    "candidate_b_migration_0040_upgrades_a_live_legacy_base_cursor",
    "--", "--ignored", "--nocapture"
  ], {
    MDBASE_PROJECTION_DATABASE_URL:
      `postgres://mdbase:${password}@127.0.0.1:${port}/${migrationDatabase}`
  });
  await run("cargo", [
    "test", "-p", "mdbase-connect-hosted-provider",
    "--test", "projection_lifecycle", "--", "--ignored", "--nocapture",
    "--test-threads=1",
    "--skip", "candidate_b_migration_0040_upgrades_a_live_legacy_base_cursor",
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await execute(
      "docker",
      ["exec", container, "pg_isready", "-U", "mdbase"],
      { cwd: root }
    ).then(() => true, () => false);
    if (ready) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error("PostgreSQL did not become ready within 30 seconds");
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
