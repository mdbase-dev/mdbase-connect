#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 256 * 1024;
const REQUIRED_OPERATIONS = ["describe", "read"];
const CLI_APPLICATION_MANIFEST = {
  manifest_version: 1,
  distribution: "portable",
  id: "dev.mdbase.cli",
  name: "mdbase CLI",
  requirements: {
    access: "full_collection",
    contracts: [],
    capabilities: {
      contract_version: 2,
      required: [
        "collection.read",
        "records.create",
        "records.edit",
        "records.delete",
        "views.manage",
        "definitions.manage",
        "offline.replica"
      ]
    }
  }
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

const INPUTS = {
  environment: "MDBASE_HOSTED_CANARY_ENVIRONMENT",
  cli: "MDBASE_HOSTED_CANARY_CLI",
  "state-dir": "MDBASE_HOSTED_CANARY_STATE_DIR",
  "expected-origin": "MDBASE_HOSTED_CANARY_EXPECTED_ORIGIN",
  collection: "MDBASE_HOSTED_CANARY_COLLECTION",
  "expected-collection-name": "MDBASE_HOSTED_CANARY_EXPECTED_COLLECTION_NAME",
  "marker-path": "MDBASE_HOSTED_CANARY_MARKER_PATH",
  "expected-marker-sha256": "MDBASE_HOSTED_CANARY_EXPECTED_MARKER_SHA256",
  "timeout-ms": "MDBASE_HOSTED_CANARY_TIMEOUT_MS"
};

class CanaryError extends Error {
  constructor(stage, code, exitCode = 1) {
    super(code);
    this.stage = stage;
    this.code = code;
    this.exitCode = exitCode;
  }
}

function configError(code = "invalid_config") {
  return new CanaryError("config", code, 2);
}

function parseArguments(argv, environmentVariables) {
  const supplied = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw configError();
    }
    const name = flag.slice(2);
    if (!Object.hasOwn(INPUTS, name) || supplied.has(name)) throw configError();
    supplied.set(name, value);
  }

  const value = (name) => {
    const argument = supplied.get(name);
    const environmentValue = environmentVariables[INPUTS[name]];
    if (argument !== undefined && environmentValue !== undefined) throw configError();
    const result = argument ?? environmentValue;
    if (result === undefined || result === "") throw configError();
    return result;
  };

  const environment = value("environment");
  const cli = value("cli");
  const stateDir = value("state-dir");
  const expectedOrigin = value("expected-origin");
  const collectionId = value("collection");
  const expectedCollectionName = value("expected-collection-name");
  const markerPath = value("marker-path");
  const expectedMarkerSha256 = value("expected-marker-sha256");
  const timeoutText = value("timeout-ms");
  const timeoutMs = Number(timeoutText);

  let parsedOrigin;
  try {
    parsedOrigin = new URL(expectedOrigin);
  } catch {
    throw configError();
  }
  if (!ENVIRONMENT.test(environment)
      || !isAbsolute(cli)
      || !isAbsolute(stateDir)
      || !["https:", "http:"].includes(parsedOrigin.protocol)
      || parsedOrigin.origin !== expectedOrigin
      || parsedOrigin.username
      || parsedOrigin.password
      || !UUID.test(collectionId)
      || expectedCollectionName.length > 200
      || markerPath.length > 1024
      || posix.isAbsolute(markerPath)
      || markerPath.split("/").some((part) => part === "" || part === "." || part === "..")
      || !DIGEST.test(expectedMarkerSha256)
      || !/^[1-9][0-9]*$/u.test(timeoutText)
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs > 300_000) {
    throw configError();
  }

  return {
    environment,
    cli,
    stateDir,
    expectedOrigin,
    collectionId,
    expectedCollectionName,
    markerPath,
    expectedMarkerSha256,
    timeoutMs
  };
}

function elapsed(started) {
  return Math.max(0, Math.round(performance.now() - started));
}

function parseJson(stdout, stage) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new CanaryError(stage, "malformed_json");
  }
}

function operationResult(value, stage) {
  if (value?.valid !== true || value.result === undefined) {
    throw new CanaryError(stage, "invalid_response");
  }
  return value.result;
}

export function markerDocumentSha256(document) {
  return `sha256:${createHash("sha256").update(document, "utf8").digest("hex")}`;
}

export async function runCanary(
  argv = process.argv.slice(2),
  environmentVariables = process.env,
  dependencies = {}
) {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  const stages = [];
  const environmentArgument = argv.indexOf("--environment");
  const suppliedEnvironment = environmentArgument === -1
    ? environmentVariables[INPUTS.environment]
    : argv[environmentArgument + 1];
  let environment = ENVIRONMENT.test(suppliedEnvironment ?? "") ? suppliedEnvironment : "unknown";
  let currentStage = "config";

  const runStage = async (name, action) => {
    currentStage = name;
    const stageStarted = performance.now();
    try {
      const result = await action();
      stages.push({ name, status: "operational", duration_ms: elapsed(stageStarted) });
      return result;
    } catch (error) {
      stages.push({ name, status: "failed", duration_ms: elapsed(stageStarted) });
      throw error;
    }
  };

  try {
    const options = await runStage("config", async () => {
      const parsed = parseArguments(argv, environmentVariables);
      environment = parsed.environment;
      if (environmentVariables.MDBASE_CONNECT_SOCKET) throw configError("endpoint_override");
      await access(parsed.cli, constants.X_OK).catch(() => { throw configError("cli_unavailable"); });
      const state = await stat(parsed.stateDir).catch(() => { throw configError("state_unavailable"); });
      if (!state.isDirectory()) throw configError("state_unavailable");
      let cloud;
      try {
        cloud = JSON.parse(await readFile(resolve(parsed.stateDir, "cloud.json"), "utf8"));
      } catch {
        throw configError("invalid_state_config");
      }
      if (cloud?.server_url !== parsed.expectedOrigin) throw configError("origin_mismatch");
      return parsed;
    });

    const deadline = performance.now() + options.timeoutMs;
    const remainingTime = (stage) => {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new CanaryError(stage, "timeout");
      return remaining;
    };
    const runCli = async (stage, argumentsList) => {
      const remaining = remainingTime(stage);
      try {
        const { stdout } = await execFileAsync(options.cli, argumentsList, {
          env: environmentVariables,
          timeout: remaining,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true
        });
        return parseJson(stdout, stage);
      } catch (error) {
        if (error instanceof CanaryError) throw error;
        if (error?.killed || error?.code === "ETIMEDOUT") throw new CanaryError(stage, "timeout");
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          throw new CanaryError(stage, "output_limit");
        }
        throw new CanaryError(stage, "cli_failed");
      }
    };
    await runStage("registration", async () => {
      let response;
      try {
        response = await (dependencies.fetchImpl ?? fetch)(
          `${options.expectedOrigin}/v1/apps/register`,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json"
            },
            body: JSON.stringify({ manifest: CLI_APPLICATION_MANIFEST }),
            signal: AbortSignal.timeout(remainingTime("registration"))
          }
        );
      } catch (error) {
        if (error?.name === "AbortError" || error?.name === "TimeoutError") {
          throw new CanaryError("registration", "timeout");
        }
        throw new CanaryError("registration", "network_error");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new CanaryError("registration", `http_${response.status}`);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new CanaryError("registration", "malformed_json");
      }
      if (
        typeof body?.application?.id !== "string"
        || !UUID.test(body.application.id)
        || typeof body.application.manifest_digest !== "string"
        || !/^[0-9a-f]{64}$/u.test(body.application.manifest_digest)
      ) {
        throw new CanaryError("registration", "invalid_response");
      }
    });

    const common = ["--state-dir", options.stateDir, "--json"];
    const operation = (stage, name, input) => runCli(stage, [
      ...common,
      "connect", "operation", options.collectionId, name,
      "--input", JSON.stringify(input)
    ]);

    await runStage("connections", async () => {
      const connections = await runCli("connections", [
        ...common, "connect", "hosted", "connections"
      ]);
      if (!Array.isArray(connections)) throw new CanaryError("connections", "invalid_response");
      const matching = connections.filter((item) => item?.collection_id === options.collectionId);
      if (matching.length !== 1) throw new CanaryError("connections", "missing_grant");
      const connection = matching[0];
      const operations = Array.isArray(connection.operations)
        ? [...new Set(connection.operations)].sort()
        : [];
      if (connection.collection_name !== options.expectedCollectionName
          || operations.length !== REQUIRED_OPERATIONS.length
          || operations.some((item, index) => item !== REQUIRED_OPERATIONS[index])) {
        throw new CanaryError("connections", "grant_mismatch");
      }
    });

    await runStage("describe", async () => {
      const described = await operation("describe", "describe", {});
      if (described?.collection_id !== options.collectionId
          || described?.display_name !== options.expectedCollectionName) {
        throw new CanaryError("describe", "collection_mismatch");
      }
    });

    let document;
    await runStage("read", async () => {
      const record = operationResult(await operation("read", "read", {
        path: options.markerPath,
        include_document: true
      }), "read");
      if (record?.path !== options.markerPath || typeof record.document !== "string") {
        throw new CanaryError("read", "marker_mismatch");
      }
      document = record.document;
    });

    await runStage("digest", async () => {
      if (markerDocumentSha256(document) !== options.expectedMarkerSha256) {
        throw new CanaryError("digest", "digest_mismatch");
      }
    });

    return {
      exitCode: 0,
      result: {
        schema_version: 1,
        environment,
        component: "hosted_canary",
        status: "operational",
        checked_at: checkedAt,
        duration_ms: elapsed(started),
        stages
      }
    };
  } catch (error) {
    const failure = error instanceof CanaryError
      ? error
      : new CanaryError(currentStage, "internal_error");
    if (!stages.some((stage) => stage.name === failure.stage && stage.status === "failed")) {
      stages.push({ name: failure.stage, status: "failed", duration_ms: 0 });
    }
    return {
      exitCode: failure.exitCode,
      result: {
        schema_version: 1,
        environment,
        component: "hosted_canary",
        status: "failed",
        checked_at: checkedAt,
        duration_ms: elapsed(started),
        stages,
        error: { stage: failure.stage, code: failure.code }
      }
    };
  }
}

async function main() {
  const { exitCode, result } = await runCanary();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
