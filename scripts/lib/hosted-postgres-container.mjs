import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const repoRoot = resolve(import.meta.dirname, "../..");

// One disposable loopback PostgreSQL 18 container for a hosted-provider suite.
export async function startHostedPostgres(name) {
  const container = `${name}-${process.pid}`;
  const password = `postgres-${randomUUID()}`;
  await execute("docker", [
    "run", "--rm", "-d", "--name", container,
    "-e", "POSTGRES_USER=mdbase",
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-e", "POSTGRES_DB=mdbase",
    "-p", "127.0.0.1::5432",
    "postgres:18-alpine"
  ], { cwd: repoRoot });
  const stop = () => execute("docker", ["stop", container], { cwd: repoRoot }).catch(() => {});
  try {
    const { stdout } = await execute("docker", ["port", container, "5432/tcp"], { cwd: repoRoot });
    const port = stdout.match(/:(\d+)/)?.[1];
    if (!port) throw new Error(`Could not determine PostgreSQL port from ${JSON.stringify(stdout)}`);
    await waitForPostgres(container);
    return {
      container,
      databaseUrl: (database) => `postgres://mdbase:${password}@127.0.0.1:${port}/${database}`,
      createDatabase: (database, options = []) => execute(
        "docker",
        ["exec", container, "createdb", "-U", "mdbase", ...options, database],
        { cwd: repoRoot }
      ),
      stop
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function waitForPostgres(container) {
  // The image briefly starts an initialization server before restarting into
  // the final TCP-serving process. Require consecutive ready samples so tests
  // cannot race that restart and receive a connection reset.
  let consecutiveReady = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await execute(
      "docker",
      ["exec", container, "pg_isready", "-U", "mdbase"],
      { cwd: repoRoot }
    ).then(() => true, () => false);
    consecutiveReady = ready ? consecutiveReady + 1 : 0;
    if (consecutiveReady === 4) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error("PostgreSQL did not remain ready within 30 seconds");
}

export function run(command, args, extraEnvironment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
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
