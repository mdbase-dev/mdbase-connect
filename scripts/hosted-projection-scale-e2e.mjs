import { run, startHostedPostgres } from "./lib/hosted-postgres-container.mjs";

// Large-fixture projection tests are independent of the adversarial suite's
// ordered schema scenarios; each owns a fresh database.
const postgres = await startHostedPostgres("mdbase-projection-scale-postgres");

try {
  for (const [index, testName] of [
    "candidate_b_base_candidate_prunes_100k_live_rows",
    "candidate_b_exact_projected_filter_and_group_100k",
    "candidate_b_exact_projected_filter_and_group_230k"
  ].entries()) {
    const largeDatabase = `mdbase_projection_large_${index}`;
    await postgres.createDatabase(largeDatabase);
    await run("cargo", [
      "test", "-p", "mdbase-connect-hosted-provider",
      "--test", "projection_lifecycle", testName,
      "--", "--ignored", "--nocapture"
    ], {
      MDBASE_HOSTED_EXECUTION_TEST_ENTITLEMENT: "large_fixture_v1",
      MDBASE_PROJECTION_DATABASE_URL: postgres.databaseUrl(largeDatabase)
    });
  }
} finally {
  await postgres.stop();
}
