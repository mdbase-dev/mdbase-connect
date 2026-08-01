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
