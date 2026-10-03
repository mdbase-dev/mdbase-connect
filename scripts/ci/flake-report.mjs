import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const reportDir = process.env.CI_FLAKE_DIR || fileURLToPath(new URL("../../.ci-flakes/", import.meta.url));
export function recordFailure(record) {
  mkdirSync(reportDir, { recursive: true });
  const row = { ...record, platform: process.platform, iteration: process.env.CI_FLAKE_ITERATION || "1" };
  appendFileSync(resolve(reportDir, `results-${process.pid}.jsonl`), `${JSON.stringify(row)}\n`);
  const message = `${row.recovered ? "Recovered flake" : "Test failure"}: ${row.suite} :: ${row.test}`;
  const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.log(process.env.GITHUB_ACTIONS ? `::${row.recovered ? "warning" : "error"}::${escaped}` : message);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${message.replaceAll("`", "'").replaceAll("\n", " ")}\n`);
}
