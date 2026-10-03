// Runs only in the trusted scheduled/dispatch workflow's reporting job.
// Downloaded artifacts are data, never executable code.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function records(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const file = join(path, entry.name);
    if (entry.isDirectory()) return records(file);
    return entry.name.endsWith(".jsonl") ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  });
}
const rows = records(process.argv[2]);
if (!rows.length) {
  console.log("No test failures recorded; no tracking issue update needed.");
  process.exit(0);
}
const dryRun = process.argv.includes("--dry-run");
const repository = process.env.GITHUB_REPOSITORY;
const api = async (path, method = "GET", body) => {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const marker = "<!-- ci-flake-stress-tracker -->";
const title = "CI flake stress tracking";
let existing;
for (let page = 1; !dryRun; page++) {
  const issues = await api(`issues?state=all&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
  existing = issues.find((issue) => !issue.pull_request && issue.user.login === "github-actions[bot]" && issue.body?.includes(marker));
  if (existing || issues.length < 100) break;
}
const url = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const safe = (value) => String(value).replaceAll("`", "'").replaceAll("\n", " ");
const body = `${marker}\nNightly stress runs do not retry failures. Fix root causes; do not widen timeouts or add sleeps.\n\nLatest failure evidence: [run and full artifacts](${url}).\n\n` +
  rows.slice(0, 150).map((row) => `- ${safe(row.platform)} iteration ${safe(row.iteration)}: \`${safe(row.suite)} :: ${safe(row.test)}\` (${row.recovered ? "recovered retry" : "failed"})`).join("\n") +
  (rows.length > 150 ? `\n\n${rows.length - 150} more records in the run artifacts.` : "") +
  (existing ? `\n\nPrevious evidence is retained in [issue edit history](${existing.html_url}).` : "");
const payload = { title, body, ...(existing ? { state: "open" } : {}) };
if (dryRun) console.log(JSON.stringify(payload, null, 2));
else await api(existing ? `issues/${existing.number}` : "issues", existing ? "PATCH" : "POST", payload);
