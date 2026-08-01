import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const composeFile = resolve(repoRoot, "docker-compose.yml");

export async function startConnectTestEnvironment(options = {}) {
  validateOptions(options);
  const connectPort = options.connectPort ?? await availablePort();
  const natsPort = options.natsPort ?? await availablePort();
  const suffix = randomBytes(5).toString("hex");
  const projectName = sanitizeProjectName(
    options.projectName ?? `mdbase-connect-e2e-${process.pid}-${suffix}`
  );
  const serverUrl = `http://127.0.0.1:${connectPort}`;
  const environment = {
    ...process.env,
    COMPOSE_PROJECT_NAME: projectName,
    PUBLIC_URL: serverUrl,
    POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
    MDBASE_CONNECT_BIND_PORT: String(connectPort),
    MDBASE_CONNECT_NATS_BIND_PORT: String(natsPort),
    MDBASE_CONNECT_RELAY_NATS_TOKEN: randomBytes(32).toString("base64url"),
    MDBASE_CONNECT_SERVER_IMAGE:
      options.serverImage ?? "mdbase-connect-server:test",
    MDBASE_CONNECT_NATS_IMAGE:
      options.natsImage ?? "mdbase-connect-nats:test",
    ...(options.allowLocalApps
      ? { MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS: "1" }
      : {}),
    ...(options.editorOrigin
      ? {
          MDBASE_EDITOR_ORIGIN: options.editorOrigin,
          MDBASE_CONNECT_MANAGEMENT_ORIGINS: options.editorOrigin
        }
      : {}),
    ...(options.hostedProvider
      ? {
          MDBASE_CONNECT_HOSTED_COLLECTIONS: "1",
          MDBASE_CONNECT_HOSTED_PROVIDER_URL: options.hostedProvider.url,
          MDBASE_CONNECT_HOSTED_PROVIDER_PUBLIC_URL:
            options.hostedProvider.publicUrl ?? options.hostedProvider.url,
          MDBASE_CONNECT_HOSTED_PROVIDER_INTERNAL_TOKEN:
            options.hostedProvider.internalToken,
          MDBASE_CONNECT_ALLOW_INSECURE_HOSTED_PROVIDER: "1"
        }
      : {})
  };
  const baseArguments = [
    "compose",
    "--file",
    composeFile,
    "--project-name",
    projectName
  ];
  let closed = false;
  const buildImages =
    options.build ?? (process.env.MDBASE_CONNECT_E2E_BUILD !== "0");

  const compose = async (arguments_, commandOptions = {}) =>
    run("docker", [...baseArguments, ...arguments_], {
      cwd: repoRoot,
      env: environment,
      capture: commandOptions.capture === true
    });

  try {
    const upArguments = ["up", "--detach", "--wait", "--wait-timeout", "180"];
    if (buildImages) upArguments.push("--build");
    await compose(upArguments);
    await waitForReady(serverUrl, options.readyTimeoutMs ?? 180_000);
  } catch (error) {
    await compose(["logs", "--no-color"]).catch(() => {});
    await compose(["down", "--volumes", "--remove-orphans", "--timeout", "5"])
      .catch(() => {});
    throw error;
  }

  return {
    projectName,
    repoRoot,
    serverUrl,
    connectPort,
    natsPort,
    environment,
    compose,
    async close() {
      if (closed) return;
      closed = true;
      await compose(["down", "--volumes", "--remove-orphans", "--timeout", "5"]);
    }
  };
}

function validateOptions(options) {
  if (!options.hostedProvider) return;
  for (const name of ["url", "internalToken"]) {
    if (
      typeof options.hostedProvider[name] !== "string"
      || !options.hostedProvider[name].trim()
    ) {
      throw new Error(`hostedProvider.${name} is required`);
    }
  }
  if (options.hostedProvider.internalToken.length < 32) {
    throw new Error("hostedProvider.internalToken must contain at least 32 characters");
  }
}

export async function waitForReady(serverUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverUrl}/ready`, {
        signal: AbortSignal.timeout(2_000)
      });
      lastStatus = `HTTP ${response.status}`;
      if (response.ok) return;
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Connect did not become ready at ${serverUrl}: ${lastStatus}`);
}

export function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port)
      );
    });
  });
}

export function sanitizeProjectName(value) {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (!sanitized || !/^[a-z0-9]/.test(sanitized)) {
    throw new Error("The Docker Compose project name is invalid");
  }
  if (sanitized === value && sanitized.length <= 63) return sanitized;

  // Docker resource names need a bounded, normalized project name. Retain a
  // digest whenever normalization would otherwise discard information so two
  // explicitly different test environments cannot silently become one.
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  const prefix = sanitized
    .slice(0, 50)
    .replace(/[-_]+$/g, "");
  return `${prefix}-${digest}`;
}

function run(command, arguments_, options) {
  return new Promise((resolveRun, reject) => {
    const output = [];
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.capture
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"]
    });
    if (options.capture) {
      child.stdout.on("data", (chunk) => output.push(chunk));
      child.stderr.on("data", (chunk) => output.push(chunk));
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const text = Buffer.concat(output).toString("utf8");
      if (code === 0) {
        resolveRun(text);
        return;
      }
      reject(new Error(
        `${command} ${arguments_.join(" ")} failed`
        + (signal ? ` with ${signal}` : ` with exit code ${code}`)
        + (text ? `\n${text}` : "")
      ));
    });
  });
}
