import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  Tray
} from "electron";
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { ensureAgentReady, type AgentPing } from "./agent-startup";
import { contractSetupInput } from "./contract-setup-input";
import { AgentControlError, requestAgent } from "./control-client";
import { buildEditorUrl } from "./editor-url";
import { ElectronUpdateBackend } from "./electron-update-backend";
import { createTrayImage } from "./tray-image";
import { UpdateCoordinator } from "./update-coordinator";
import { UpdateStateStore } from "./update-state";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentStartup: Promise<void> | null = null;
let daemonPaths: { stateDir: string; endpoint: string } | null = null;
let updater: UpdateCoordinator | null = null;
let quitting = false;
const activePairings = new Map<string, { serverUrl: string; secret: string }>();
const execFile = promisify(execFileCallback);

const userDataOverride = process.env.MDBASE_CONNECT_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", resolve(userDataOverride));

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

autoUpdater.on("before-quit-for-update", () => {
  quitting = true;
});

function stateDirectory(): string {
  if (!daemonPaths) throw new Error("The connector runtime has not been initialized.");
  return daemonPaths.stateDir;
}

function controlEndpoint(): string {
  if (!daemonPaths) throw new Error("The connector runtime has not been initialized.");
  return daemonPaths.endpoint;
}

function connectBinary(): string {
  const extension = process.platform === "win32" ? ".exe" : "";
  const override = process.env.MDBASE_CONNECT_BIN;
  if (override) return override;
  if (app.isPackaged) {
    return join(process.resourcesPath, `mdbase${extension}`);
  }
  return resolve(__dirname, `../../../../target/debug/mdbase${extension}`);
}

async function resolveDaemonPaths(): Promise<void> {
  const binary = connectBinary();
  if (!existsSync(binary)) throw new Error(`Connector runtime is missing: ${binary}`);
  const { stdout } = await execFile(binary, ["--json", "connect", "paths"], {
    env: process.env,
    timeout: 10_000,
    windowsHide: true
  });
  const paths = JSON.parse(stdout) as { state_dir?: unknown; endpoint?: unknown };
  if (typeof paths.state_dir !== "string" || typeof paths.endpoint !== "string") {
    throw new Error("The connector runtime returned invalid path information.");
  }
  daemonPaths = { stateDir: paths.state_dir, endpoint: paths.endpoint };
}

async function ensureAgent(): Promise<void> {
  if (agentStartup) return agentStartup;
  agentStartup = startAgent().finally(() => {
    agentStartup = null;
  });
  return agentStartup;
}

async function requestReadyAgent<T>(
  method: string,
  params?: unknown,
  timeoutMs = 5_000
): Promise<T> {
  await ensureAgent();
  return requestAgent<T>(controlEndpoint(), method, params, timeoutMs);
}

function endpointIsUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

function incompatibleDaemon(error: unknown): boolean {
  return error instanceof AgentControlError && error.code === "unsupported_local_protocol";
}

async function startAgent(): Promise<void> {
  await ensureAgentReady({
    ping: (timeoutMs) =>
      requestAgent<AgentPing>(controlEndpoint(), "ping", undefined, timeoutMs),
    endpointIsUnavailable,
    incompatibleDaemon,
    launch: async () => {
      const binary = connectBinary();
      if (!existsSync(binary)) {
        throw new Error(`Connector runtime is missing: ${binary}`);
      }
      await mkdir(stateDirectory(), { recursive: true });
      await execFile(
        binary,
        [
          "--state-dir",
          stateDirectory(),
          "--endpoint",
          controlEndpoint(),
          "connect",
          "daemon",
          "start"
        ],
        {
          env: process.env,
          timeout: 30_000,
          windowsHide: true
        }
      );
    }
  });
}

function trustedIpc(event: Electron.IpcMainInvokeEvent): void {
  const source = event.senderFrame?.url ?? "";
  if (!source.startsWith("file://")) {
    throw new Error("Untrusted renderer attempted to use the connector API.");
  }
}

async function chooseFolder(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: "Choose a collection folder",
    properties: ["openDirectory", "createDirectory"]
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

function registerIpc(): void {
  ipcMain.handle("connect:status", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("status");
  });
  ipcMain.handle("connect:updates:status", (event) => {
    trustedIpc(event);
    if (!updater) throw new Error("The updater has not been initialized.");
    return updater.status();
  });
  ipcMain.handle("connect:updates:check", async (event) => {
    trustedIpc(event);
    if (!updater) throw new Error("The updater has not been initialized.");
    return updater.check(true);
  });
  ipcMain.handle("connect:updates:install", async (event) => {
    trustedIpc(event);
    if (!updater) throw new Error("The updater has not been initialized.");
    return updater.install();
  });
  ipcMain.handle("connect:collections:list", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("collections.list");
  });
  ipcMain.handle("connect:collections:add", async (event) => {
    trustedIpc(event);
    const path = await chooseFolder();
    if (!path) return null;
    try {
      return {
        status: "added",
        collection: await requestReadyAgent("collections.add", { path })
      };
    } catch (error) {
      if (error instanceof AgentControlError && error.code === "duplicate_collection_identity") {
        return { status: "copy_requires_new_identity", path };
      }
      throw error;
    }
  });
  ipcMain.handle("connect:collections:add-copy", async (event, path: unknown) => {
    trustedIpc(event);
    if (typeof path !== "string" || path.length === 0) throw new Error("Choose a folder.");
    return requestReadyAgent("collections.add-copy", { path });
  });
  ipcMain.handle("connect:collections:make-independent", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    return requestReadyAgent(
      "collections.make-independent",
      { collection_id: collectionId },
      10_000
    );
  });
  ipcMain.handle("connect:collections:take-authority", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    return requestReadyAgent(
      "collections.take-authority",
      { collection_id: collectionId },
      15_000
    );
  });
  ipcMain.handle("connect:collections:transfer-authority", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    const collections = await requestReadyAgent<Array<{
      id: string;
      display_name: string;
      path: string;
    }>>("collections.list");
    const collection = collections.find((candidate) => candidate.id === collectionId);
    if (!collection) throw new Error("The local collection is no longer registered.");
    const transfer = await requestReadyAgent<{
      status: "completed";
      collection_id: string;
      authority_epoch: number;
    }>(
      "collections.transfer-authority",
      { collection_id: collectionId, target: "remote" },
      10 * 60 * 1_000
    );
    const mirror = await requestReadyAgent(
      "mirrors.add",
      {
        collection_id: collectionId,
        path: collection.path,
        mode: "read_write",
        name: `${hostname().trim() || "This computer"} mirror`
      },
      2 * 60 * 1_000
    );
    return { transfer, mirror };
  });
  ipcMain.handle("connect:collections:choose-create", async (event) => {
    trustedIpc(event);
    return chooseFolder();
  });
  ipcMain.handle("connect:collections:create", async (event, input: unknown) => {
    trustedIpc(event);
    if (!input || typeof input !== "object") throw new Error("Invalid collection input.");
    const { path, name } = input as { path?: unknown; name?: unknown };
    if (typeof path !== "string" || path.length === 0) throw new Error("Choose a folder.");
    if (typeof name !== "string" || name.trim().length === 0) throw new Error("Enter a collection name.");
    return requestReadyAgent("collections.create", { path, name: name.trim() });
  });
  ipcMain.handle("connect:collections:update-metadata", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid collection metadata.");
    const collectionId = value.collectionId;
    const name = value.name;
    const description = value.description;
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    if (typeof name !== "string" || name.trim().length === 0 || [...name.trim()].length > 100) {
      throw new Error("Collection name must be between 1 and 100 characters.");
    }
    if (description !== undefined && (typeof description !== "string" || [...description.trim()].length > 500)) {
      throw new Error("Collection description must be 500 characters or fewer.");
    }
    return requestReadyAgent("collections.update-metadata", {
      collection_id: collectionId,
      name: name.trim(),
      description: typeof description === "string" && description.trim() ? description.trim() : undefined
    });
  });
  ipcMain.handle("connect:collections:set-enabled", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid collection setting.");
    if (typeof value.collectionId !== "string" || typeof value.enabled !== "boolean") {
      throw new Error("Invalid collection setting.");
    }
    return requestReadyAgent("collections.set-enabled", {
      collection_id: value.collectionId,
      enabled: value.enabled
    });
  });
  ipcMain.handle("connect:collections:validate", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    return requestReadyAgent("collections.validate", {
      collection_id: collectionId
    });
  });
  ipcMain.handle("connect:collections:remove", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    return requestReadyAgent("collections.remove", {
      collection_id: collectionId
    });
  });
  ipcMain.handle("connect:path:open", async (event, path: unknown) => {
    trustedIpc(event);
    if (typeof path !== "string") throw new Error("Invalid path.");
    const collection = (await requestReadyAgent<Array<{ path: string }>>(
      "collections.list"
    )).find((candidate) => candidate.path === path);
    if (!collection) throw new Error("That path is not a registered collection.");
    return shell.openPath(collection.path);
  });
  ipcMain.handle("connect:collections:open-config", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    const collection = (await requestReadyAgent<Array<{ id: string; path: string }>>(
      "collections.list"
    )).find((candidate) => candidate.id === collectionId);
    if (!collection) throw new Error("That collection is not registered.");
    return shell.openPath(join(collection.path, "mdbase.yaml"));
  });
  ipcMain.handle("connect:editor:open", async (event, collectionId: unknown) => {
    trustedIpc(event);
    return shell.openExternal(buildEditorUrl(collectionId));
  });
  ipcMain.handle("connect:startup:get", async (event) => {
    trustedIpc(event);
    return getLaunchAtLogin();
  });
  ipcMain.handle("connect:startup:set", async (event, enabled: unknown) => {
    trustedIpc(event);
    if (typeof enabled !== "boolean") throw new Error("Invalid startup setting.");
    return setLaunchAtLogin(enabled);
  });
  ipcMain.handle("connect:cloud:get", async (event) => {
    trustedIpc(event);
    const configuration = await requestReadyAgent<{
      configured: boolean;
      server_url: string | null;
    }>("account.configuration");
    return {
      configured: configuration.configured,
      serverUrl: configuration.server_url
    };
  });
  ipcMain.handle("connect:cloud:set", async (event, input: unknown) => {
    trustedIpc(event);
    if (!input || typeof input !== "object") throw new Error("Invalid cloud connection input.");
    const { serverUrl, connectorToken } = input as {
      serverUrl?: unknown;
      connectorToken?: unknown;
    };
    if (typeof serverUrl !== "string" || typeof connectorToken !== "string") {
      throw new Error("Server URL and connector token are required.");
    }
    await requestReadyAgent(
      "account.configure",
      { server_url: serverUrl, connector_token: connectorToken },
      10_000
    );
    restartApplication();
    return { configured: true, serverUrl };
  });
  ipcMain.handle("connect:cloud:clear", async (event) => {
    trustedIpc(event);
    await requestReadyAgent("account.clear", undefined, 10_000);
    restartApplication();
    return { configured: false, serverUrl: null };
  });
  ipcMain.handle("connect:pairing:begin", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid pairing input.");
    const serverUrl = validateServerUrl(value.serverUrl);
    const connectorName = typeof value.connectorName === "string" && value.connectorName.trim()
      ? value.connectorName.trim().slice(0, 100)
      : hostname();
    const response = await fetch(`${serverUrl}/v1/pairing-requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connector_name: connectorName })
    });
    const body = await response.json() as {
      pairing_id?: string;
      pairing_secret?: string;
      verification_uri?: string;
      expires_in?: number;
      error?: { message?: string };
    };
    if (
      !response.ok
      || !body.pairing_id
      || !body.pairing_secret
      || !body.verification_uri
      || !body.pairing_secret.startsWith("pair_")
      || body.pairing_secret.length < 24
      || /\s/.test(body.pairing_secret)
      || !body.expires_in
      || body.expires_in > 86_400
    ) {
      throw new Error(body.error?.message ?? `Pairing failed with HTTP ${response.status}.`);
    }
    const verification = new URL(body.verification_uri);
    if (
      verification.origin !== new URL(serverUrl).origin
      || verification.username
      || verification.password
    ) {
      throw new Error("The pairing server returned an untrusted verification address.");
    }
    activePairings.set(body.pairing_id, { serverUrl, secret: body.pairing_secret });
    await shell.openExternal(body.verification_uri);
    return {
      pairingId: body.pairing_id,
      verificationUri: body.verification_uri,
      expiresIn: body.expires_in ?? 600
    };
  });
  ipcMain.handle("connect:pairing:status", async (event, pairingId: unknown) => {
    trustedIpc(event);
    if (typeof pairingId !== "string") throw new Error("Invalid pairing request.");
    const pairing = activePairings.get(pairingId);
    if (!pairing) throw new Error("That pairing request is no longer active.");
    const response = await fetch(`${pairing.serverUrl}/v1/pairing-requests/${pairingId}/exchange`, {
      method: "POST",
      headers: { authorization: `Bearer ${pairing.secret}` }
    });
    const body = await response.json() as {
      status?: "pending" | "paired";
      token?: string;
      connector?: { id: string; name: string };
      error?: { message?: string };
    };
    if (response.status === 202) return { status: "pending" };
    if (!response.ok || body.status !== "paired" || !body.token) {
      throw new Error(body.error?.message ?? `Pairing failed with HTTP ${response.status}.`);
    }
    activePairings.delete(pairingId);
    await requestReadyAgent(
      "account.configure",
      { server_url: pairing.serverUrl, connector_token: body.token },
      10_000
    );
    restartApplication(1_000);
    return { status: "paired", connector: body.connector };
  });
  ipcMain.handle("connect:access:snapshot", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("access.snapshot", undefined, 8_000);
  });
  ipcMain.handle("connect:access:pause", async (event, paused: unknown) => {
    trustedIpc(event);
    if (typeof paused !== "boolean") throw new Error("Invalid pause setting.");
    return requestReadyAgent("access.pause", { paused }, 10_000);
  });
  ipcMain.handle("connect:account:rename-computer", async (event, name: unknown) => {
    trustedIpc(event);
    if (typeof name !== "string" || name.trim().length === 0 || [...name.trim()].length > 100) {
      throw new Error("Computer name must be between 1 and 100 characters.");
    }
    return requestReadyAgent("account.rename-computer", { name: name.trim() }, 10_000);
  });
  ipcMain.handle("connect:grants:create", async (event, input: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("grants.create", grantInput(input, true), 10_000);
  });
  ipcMain.handle("connect:grants:update", async (event, input: unknown) => {
    trustedIpc(event);
    return requestReadyAgent("grants.update", grantInput(input, false), 10_000);
  });
  ipcMain.handle("connect:grants:revoke", async (event, grantId: unknown) => {
    trustedIpc(event);
    if (typeof grantId !== "string") throw new Error("Invalid grant ID.");
    return requestReadyAgent("grants.revoke", { grant_id: grantId }, 10_000);
  });
  ipcMain.handle("connect:authorizations:approve", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid authorization decision.");
    if (typeof value.requestId !== "string" || typeof value.collectionId !== "string") {
      throw new Error("Choose a collection for this request.");
    }
    const operations = stringArray(value.operations, "Choose at least one operation.");
    const contractSetups = contractSetupInput(value.contractSetups);
    return requestReadyAgent(
      "authorizations.approve",
      {
        request_id: value.requestId,
        collection_id: value.collectionId,
        operations,
        contract_setups: contractSetups
      },
      10_000
    );
  });
  ipcMain.handle("connect:authorizations:deny", async (event, requestId: unknown) => {
    trustedIpc(event);
    if (typeof requestId !== "string") throw new Error("Invalid authorization request.");
    return requestReadyAgent(
      "authorizations.deny",
      { request_id: requestId },
      10_000
    );
  });
  ipcMain.handle("connect:activity:list", async (event, limit: unknown) => {
    trustedIpc(event);
    const value = typeof limit === "number" ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    return requestReadyAgent("activity.list", { limit: value });
  });
  ipcMain.handle("connect:hosted:snapshot", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("hosted.snapshot", undefined, 30_000);
  });
  ipcMain.handle("connect:hosted:create", async (event, name: unknown) => {
    trustedIpc(event);
    if (typeof name !== "string" || name.trim().length === 0 || [...name.trim()].length > 200) {
      throw new Error("Collection name must be between 1 and 200 characters.");
    }
    return requestReadyAgent(
      "hosted.collections.create",
      { name: name.trim() },
      30_000
    );
  });
  ipcMain.handle("connect:hosted:rename", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid hosted collection details.");
    if (typeof value.collectionId !== "string") throw new Error("Invalid collection ID.");
    if (typeof value.name !== "string" || value.name.trim().length === 0 || [...value.name.trim()].length > 200) {
      throw new Error("Collection name must be between 1 and 200 characters.");
    }
    return requestReadyAgent(
      "hosted.collections.rename",
      { collection_id: value.collectionId, name: value.name.trim() },
      30_000
    );
  });
  ipcMain.handle("connect:hosted:delete", async (event, collectionId: unknown) => {
    trustedIpc(event);
    if (typeof collectionId !== "string") throw new Error("Invalid collection ID.");
    return requestReadyAgent(
      "hosted.collections.delete",
      { collection_id: collectionId },
      30_000
    );
  });
  ipcMain.handle("connect:hosted:authorization-approve", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid authorization decision.");
    if (typeof value.requestId !== "string" || typeof value.collectionId !== "string") {
      throw new Error("Choose a hosted collection for this request.");
    }
    const contractSetups = contractSetupInput(value.contractSetups);
    return requestReadyAgent(
      "hosted.authorizations.approve",
      {
        request_id: value.requestId,
        collection_id: value.collectionId,
        operations: stringArray(value.operations, "Choose at least one operation."),
        contract_setups: contractSetups
      },
      30_000
    );
  });
  ipcMain.handle("connect:hosted:grant-update", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid hosted application access.");
    if (typeof value.grantId !== "string") throw new Error("Invalid grant ID.");
    return requestReadyAgent(
      "hosted.grants.update",
      {
        grant_id: value.grantId,
        operations: stringArray(value.operations, "Choose at least one operation.")
      },
      30_000
    );
  });
  ipcMain.handle("connect:hosted:grant-revoke", async (event, grantId: unknown) => {
    trustedIpc(event);
    if (typeof grantId !== "string") throw new Error("Invalid grant ID.");
    return requestReadyAgent(
      "hosted.grants.revoke",
      { grant_id: grantId },
      30_000
    );
  });
  ipcMain.handle("connect:hosted:replica-revoke", async (event, replicaId: unknown) => {
    trustedIpc(event);
    if (typeof replicaId !== "string") throw new Error("Invalid mirror ID.");
    return requestReadyAgent(
      "hosted.replicas.revoke",
      { replica_id: replicaId },
      30_000
    );
  });
  ipcMain.handle("connect:mirrors:list", async (event) => {
    trustedIpc(event);
    return requestReadyAgent("mirrors.list");
  });
  ipcMain.handle("connect:mirrors:choose-folder", async (event) => {
    trustedIpc(event);
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "Choose a folder for this hosted collection",
          properties: ["openDirectory", "createDirectory"]
        })
      : await dialog.showOpenDialog({
          title: "Choose a folder for this hosted collection",
          properties: ["openDirectory", "createDirectory"]
        });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("connect:mirrors:connect", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid mirror settings.");
    if (typeof value.collectionId !== "string" || typeof value.path !== "string") {
      throw new Error("Choose a hosted collection and folder.");
    }
    if (!["read_only", "read_write"].includes(String(value.mode))) {
      throw new Error("Choose receive-only or two-way synchronization.");
    }
    return requestReadyAgent("mirrors.add", {
      collection_id: value.collectionId,
      path: value.path,
      mode: value.mode as "read_only" | "read_write",
      name: typeof value.name === "string" ? value.name : undefined
    }, 2 * 60 * 1_000);
  });
  ipcMain.handle("connect:mirrors:sync", async (event, replicaId: unknown) => {
    trustedIpc(event);
    if (typeof replicaId !== "string") throw new Error("Invalid mirror ID.");
    return requestReadyAgent("mirrors.sync", { replica_id: replicaId }, 2 * 60 * 1_000);
  });
  ipcMain.handle("connect:mirrors:resolve", async (event, input: unknown) => {
    trustedIpc(event);
    const value = asObject(input, "Invalid conflict resolution.");
    if (
      typeof value.replicaId !== "string"
      || typeof value.recordId !== "string"
      || !["local", "remote"].includes(String(value.resolution))
    ) {
      throw new Error("Choose the local or hosted version.");
    }
    return requestReadyAgent(
      "mirrors.resolve",
      {
        replica_id: value.replicaId,
        record_id: value.recordId,
        resolution: value.resolution
      },
      2 * 60 * 1_000
    );
  });
  ipcMain.handle("connect:mirrors:promote", async (event, replicaId: unknown) => {
    trustedIpc(event);
    if (typeof replicaId !== "string") throw new Error("Invalid mirror ID.");
    const begun = await requestReadyAgent<{
      verification_uri: string;
    }>(
      "mirrors.promote.begin",
      { replica_id: replicaId },
      2 * 60 * 1_000
    );
    await shell.openExternal(begun.verification_uri);
    return requestReadyAgent(
      "mirrors.promote.complete",
      { replica_id: replicaId },
      10 * 60 * 1_000
    );
  });
  ipcMain.handle("connect:mirrors:disconnect", async (event, replicaId: unknown) => {
    trustedIpc(event);
    if (typeof replicaId !== "string") throw new Error("Invalid mirror ID.");
    return requestReadyAgent(
      "mirrors.remove",
      { replica_id: replicaId },
      30_000
    );
  });
  ipcMain.handle("connect:mirrors:open", async (event, replicaId: unknown) => {
    trustedIpc(event);
    if (typeof replicaId !== "string") throw new Error("Invalid mirror ID.");
    const mirror = (await requestReadyAgent<Array<{ replica_id: string; path: string }>>(
      "mirrors.list"
    )).find((candidate) => candidate.replica_id === replicaId);
    if (!mirror) throw new Error("That mirror is not controlled by this computer.");
    return shell.openPath(mirror.path);
  });
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new Error(message);
  }
  return [...new Set(value as string[])];
}

function grantInput(input: unknown, includeTarget: boolean): Record<string, unknown> {
  const value = asObject(input, "Invalid application access input.");
  const result: Record<string, unknown> = {
    operations: stringArray(value.operations, "Choose at least one operation.")
  };
  if (includeTarget) {
    if (typeof value.applicationId !== "string" || typeof value.collectionId !== "string") {
      throw new Error("Choose an application and collection.");
    }
    result.application_id = value.applicationId;
    result.collection_id = value.collectionId;
  } else {
    if (typeof value.grantId !== "string") throw new Error("Invalid grant ID.");
    result.grant_id = value.grantId;
  }
  return result;
}

function validateServerUrl(serverUrl: unknown): string {
  if (typeof serverUrl !== "string") throw new Error("Enter a server address.");
  const url = new URL(serverUrl.trim());
  const localDevelopment = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (!url.hostname || (url.protocol !== "https:" && !localDevelopment)) {
    throw new Error("Remote mdbase connect servers must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("The mdbase connect server address must not contain credentials.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function restartApplication(delay = 250): void {
  setTimeout(() => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  }, delay);
}

function registerDeepLinks(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("mdbase-connect", process.execPath, [resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("mdbase-connect");
  }
}

function handleDeepLink(value: string | undefined): void {
  if (!value?.startsWith("mdbase-connect://")) return;
  try {
    const url = new URL(value);
    if (url.hostname === "authorize") {
      showRoute("access");
    } else if (url.hostname === "paired") {
      showRoute("overview");
    } else if (url.hostname === "mirror") {
      const collectionId = url.searchParams.get("collection");
      showRoute(collectionId ? `collections:mirror:${collectionId}` : "collections");
    }
  } catch {
    // Ignore malformed protocol invocations.
  }
}

function showRoute(route: string): void {
  mainWindow?.show();
  mainWindow?.focus();
  const send = () => mainWindow?.webContents.send("connect:navigate", route);
  if (mainWindow?.webContents.isLoading()) mainWindow.webContents.once("did-finish-load", send);
  else send();
}

async function getLaunchAtLogin(): Promise<{ enabled: boolean; available: boolean }> {
  if (!app.isPackaged) return { enabled: false, available: false };
  if (process.platform === "linux") {
    const path = join(app.getPath("appData"), "autostart", "mdbase-connect.desktop");
    try {
      await stat(path);
      return { enabled: true, available: true };
    } catch {
      return { enabled: false, available: true };
    }
  }
  return { enabled: app.getLoginItemSettings().openAtLogin, available: true };
}

async function setLaunchAtLogin(enabled: boolean): Promise<{ enabled: boolean; available: boolean }> {
  if (!app.isPackaged) return { enabled: false, available: false };
  if (process.platform === "linux") {
    const directory = join(app.getPath("appData"), "autostart");
    const path = join(directory, "mdbase-connect.desktop");
    if (enabled) {
      await mkdir(directory, { recursive: true });
      const executable = app.getPath("exe").replaceAll('"', '\\"');
      await writeFile(
        path,
        `[Desktop Entry]\nType=Application\nName=mdbase connect\nExec="${executable}" --hidden\nX-GNOME-Autostart-enabled=true\n`,
        { mode: 0o600 }
      );
    } else {
      await rm(path, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
  }
  return getLaunchAtLogin();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 820,
    minHeight: 580,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1e24" : "#fcfcfd",
    title: "mdbase connect",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (target !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  mainWindow.once("ready-to-show", () => {
    if (!process.argv.includes("--hidden")) mainWindow?.show();
  });
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  const image = createTrayImage();
  tray = new Tray(image);
  tray.setToolTip("mdbase connect");
  refreshTrayMenu();
  tray.on("double-click", () => mainWindow?.show());
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const update = updater?.status();
  const updateReady = update?.can_install === true;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show mdbase connect", click: () => mainWindow?.show() },
      { type: "separator" },
      { label: "Local connector running", enabled: false },
      {
        label: updateReady
          ? update?.phase === "ready"
            ? `Install ${update.target_version}`
            : `Open ${update?.target_version ?? "update"}`
          : "Check for updates",
        enabled: update?.can_check === true || updateReady,
        click: () => {
          if (!updater) return;
          if (updateReady) {
            void updater.install().catch((error) => {
              dialog.showErrorBox(
                "mdbase connect could not install the update",
                error instanceof Error ? error.message : String(error)
              );
            });
          } else {
            void updater.check(true);
          }
        }
      },
      { type: "separator" },
      {
        label: "Quit mdbase connect",
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

app.whenReady().then(async () => {
  app.on("web-contents-created", (_event, contents) => {
    contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
  });
  registerDeepLinks();
  try {
    await resolveDaemonPaths();
  } catch (error) {
    dialog.showErrorBox(
      "mdbase connect could not initialize",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
    return;
  }
  updater = new UpdateCoordinator(
    new UpdateStateStore(join(app.getPath("userData"), "updates", "state.json")),
    new ElectronUpdateBackend({
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      userDataDirectory: app.getPath("userData"),
      binaryPath: connectBinary,
      stateDirectory,
      endpoint: controlEndpoint
    })
  );
  const recoveryStatus = await updater.initialize();
  updater.subscribe((status) => {
    mainWindow?.webContents.send("connect:update-status", status);
    refreshTrayMenu();
  });
  registerIpc();
  createWindow();
  createTray();
  handleDeepLink(process.argv.find((value) => value.startsWith("mdbase-connect://")));
  try {
    if (recoveryStatus.phase === "failed") throw new Error(recoveryStatus.message);
    await ensureAgent();
  } catch (error) {
    dialog.showErrorBox(
      "mdbase connect could not start",
      error instanceof Error ? error.message : String(error)
    );
  }
  const initialUpdateCheck = setTimeout(() => void updater?.check(false), 30_000);
  initialUpdateCheck.unref();
  const updateChecks = setInterval(() => void updater?.check(false), 6 * 60 * 60 * 1000);
  updateChecks.unref();
});

app.on("second-instance", (_event, argv) => {
  mainWindow?.show();
  mainWindow?.focus();
  handleDeepLink(argv.find((value) => value.startsWith("mdbase-connect://")));
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.on("activate", () => {
  if (!mainWindow) createWindow();
  mainWindow?.show();
});

app.on("before-quit", () => {
  quitting = true;
});
