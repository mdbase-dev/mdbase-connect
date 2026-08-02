import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { chromium } from "@playwright/test";
import {
  decryptRelayResponse,
  encryptRelayRequest,
  MemoryGrantKeyStore
} from "../packages/client/dist/crypto.js";
import {
  MdbaseConnect,
  applicationInstallationId,
  deriveFirstContactSas,
  signApplicationAuthorization,
  unwrapConnectOutcome
} from "../packages/client/dist/index.js";

process.env.NODE_ENV = "test";
const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const configuredLoopbackPort = process.env.MDBASE_CONNECT_E2E_LOOPBACK_PORT;
const loopbackPort = configuredLoopbackPort === undefined
  ? await availableTcpPort()
  : Number(configuredLoopbackPort);
if (!Number.isInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > 65_535) {
  throw new Error("MDBASE_CONNECT_E2E_LOOPBACK_PORT must be a valid TCP port");
}
const loopbackUrl = `http://127.0.0.1:${loopbackPort}`;
const serverPort = await availableTcpPort();
const serverUrl = `http://127.0.0.1:${serverPort}`;
const { buildApp } = await import("../services/server/dist/app.js");
const { createDatabase } = await import("../services/server/dist/db.js");
const database = await createDatabase("memory");
const { app } = await buildApp({
  db: database,
  devAuth: true,
  allowInsecureManifests: true,
  portalDist: join(repoRoot, "apps", "portal", "dist"),
  publicUrl: serverUrl
});
await app.listen({ host: "127.0.0.1", port: serverPort });
const serverAddress = app.server.address();
if (!serverAddress || typeof serverAddress === "string") throw new Error("Server did not open a TCP port");
if (serverAddress.port !== serverPort) throw new Error("Server did not bind the reserved TCP port");
const scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-e2e-"));
const stateDir = join(scratch, "state");
const collectionPath = join(scratch, "workouts");
const extension = process.platform === "win32" ? ".exe" : "";
const cliBinary = join(repoRoot, "target", "debug", `mdbase${extension}`);
let agent;
let manifestServer;
let browserManifestServer;
let onboardingBrowser;
let onboardingContext;
let onboardingPage;
let directOrigin;
const applicationKeyStore = new MemoryGrantKeyStore();
let relayContext;

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key) { return this.values.get(key) ?? null; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  removeItem(key) { this.values.delete(key); }
  setItem(key, value) { this.values.set(key, value); }
}

try {
  const session = await request("/v1/dev/session", {
    method: "POST",
    body: { name: "MVP User", email: "mvp@example.com" }
  });
  const cookie = session.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Development session did not set a cookie");

  const manifest = await openManifestServer();
  manifestServer = manifest.server;
  browserManifestServer = manifest.browserServer;
  directOrigin = manifest.origin;
  const application = await request("/v1/apps/register", {
    method: "POST",
    body: { manifest: manifest.applicationManifest }
  });
  const appId = application.body.application.id;
  const verifier = "end-to-end-pkce-verifier-with-forty-three-characters";
  const initialAuthorization = await startSignedWebAuthorization({
    application: application.body.application,
    redirectUri: manifest.redirectUri,
    verifier,
    state: "e2e",
    operations: ["describe", "changes", "read", "query", "create", "update"],
    cookie
  });
  const authorizationId = initialAuthorization.id;
  const applicationKey = initialAuthorization.grantKey;

  onboardingBrowser = await chromium.launch({ headless: true });
  onboardingContext = await onboardingBrowser.newContext();
  const cookieSeparator = cookie.indexOf("=");
  await onboardingContext.addCookies([{
    name: cookie.slice(0, cookieSeparator),
    value: cookie.slice(cookieSeparator + 1),
    url: serverUrl
  }]);
  onboardingPage = await onboardingContext.newPage();
  const onboardingErrors = [];
  onboardingPage.on("console", (message) => {
    if (message.type() === "error") onboardingErrors.push(message.text());
  });
  onboardingPage.on("pageerror", (error) => onboardingErrors.push(error.message));
  const onboardingResponse = await onboardingPage.goto(`${serverUrl}/authorize/${authorizationId}`);
  const localFolder = onboardingPage.getByRole("link", { name: "Use a local folder" });
  try {
    await localFolder.waitFor({ state: "visible" });
  } catch (error) {
    const body = (await onboardingPage.locator("body").innerText()).slice(0, 2_000);
    throw new Error(
      `Authorization onboarding did not render (HTTP ${onboardingResponse?.status() ?? "unknown"}). ` +
      `Browser errors: ${onboardingErrors.join(" | ") || "none"}. Body: ${body}`,
      { cause: error }
    );
  }
  const expectedDeepLink = `mdbase-connect://authorize?request_id=${authorizationId}`;
  if (await localFolder.getAttribute("href") !== expectedDeepLink) {
    throw new Error("The onboarding handoff did not preserve the authorization request ID");
  }
  await localFolder.evaluate((element) => {
    element.addEventListener("click", (event) => event.preventDefault(), { once: true });
  });
  await localFolder.click();
  await onboardingPage.getByRole("heading", {
    name: "Choose the folder in mdbase connect."
  }).waitFor();
  if (new URL(onboardingPage.url()).searchParams.get("continue_in_desktop") !== "1") {
    throw new Error("The browser did not retain the desktop continuation state");
  }

  const pairing = await request("/v1/pairing-requests", {
    method: "POST",
    body: { connector_name: "MVP computer" }
  });
  await request(`/v1/pairing-requests/${pairing.body.pairing_id}/approve`, {
    method: "POST",
    cookie
  });
  const paired = await request(`/v1/pairing-requests/${pairing.body.pairing_id}/exchange`, {
    method: "POST",
    authorization: `Bearer ${pairing.body.pairing_secret}`
  });
  if (paired.body.status !== "paired" || !paired.body.token) {
    throw new Error(`Connector pairing did not complete: ${JSON.stringify(paired.body)}`);
  }
  const connectorToken = paired.body.token;

  agent = startAgent([]);
  await waitForAgent();
  await run(cliBinary, [
    "--state-dir", stateDir,
    "connect",
    "collection", "create", collectionPath,
    "--name", "Workouts"
  ]);
  await writeFile(
    join(collectionPath, "mdbase.yaml"),
    `${await readFile(join(collectionPath, "mdbase.yaml"), "utf8")}\nx-obsidian:\n  bases:\n    include: ["Views/**/*.base"]\n`
  );
  await mkdir(join(collectionPath, "Views"), { recursive: true });
  await writeFile(join(collectionPath, "Views", "workouts.base"), `formulas:
  lane: if(status == "open", "Ready", "Other")
properties:
  formula.lane:
    displayName: Lane
views:
  - type: table
    name: Open workouts
    filters:
      and:
        - 'status == "open"'
    groupBy:
      property: status
      direction: ASC
    order: [status, formula.lane, file.name]
    sort:
      - property: file.path
        direction: ASC
`);
  await mkdir(join(collectionPath, "_types"), { recursive: true });
  await mkdir(join(collectionPath, "_contracts"), { recursive: true });
  await writeFile(join(collectionPath, "_contracts", "workout.record.md"), `---
kind: mdbase.contract
contract_type: record
id: workout.record
version: 1.0.0
record_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title, status]
    additionalProperties: false
    properties:
      title: { type: string }
      status: { enum: [open, done] }
---
`);
  await writeFile(join(collectionPath, "_types", "workout.md"), `---
kind: mdbase.type
name: workout
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, title]
    additionalProperties: true
    properties:
      type: { const: workout }
      title: { type: string }
      status: { enum: [open, done] }
implements:
  - contract: workout.record
    version: 1.0.0
    fields:
      title: title
      status: status
---
`);
  await writeFile(join(collectionPath, "_types", "private.md"), `---
kind: mdbase.type
name: private
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    additionalProperties: true
    properties:
      type: { const: private }
      secret: { type: string }
---
`);
  await writeFile(join(collectionPath, "private.md"), `---
type: private
secret: connector scope test
---
`);
  await mkdir(join(collectionPath, "bulk"), { recursive: true });
  await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeFile(
    join(collectionPath, "bulk", `${String(index).padStart(4, "0")}.md`),
    `---\ntype: workout\ntitle: Bulk ${index}\nstatus: open\n---\n`
  )));
  await stopAgent(agent);
  agent = startAgent(["--server-url", serverUrl], connectorToken);

  const dashboard = await poll(async () => {
    const current = await request("/v1/me", { cookie });
    return current.body.collections.length ? current.body : null;
  }, "collection metadata did not reach the portal");
  const collection = dashboard.collections[0];

  await onboardingPage.goto(`${serverUrl}/authorize/${authorizationId}`);
  const collectionChoice = onboardingPage.locator(
    `.collection-choice-list input[value="${collection.id}"]`
  );
  await collectionChoice.waitFor({ state: "visible" });
  await collectionChoice.check();
  await onboardingPage.getByRole("button", { name: "Allow MVP Workout App" }).click();
  await onboardingPage.getByRole("heading", {
    name: "Compare the first-contact code."
  }).waitFor();
  const callback = await finishSignedWebAuthorization(initialAuthorization);
  await onboardingContext.close();
  await onboardingBrowser.close();
  onboardingContext = undefined;
  onboardingBrowser = undefined;
  onboardingPage = undefined;
  const token = await request("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: appId,
      redirect_uri: manifest.redirectUri,
      code_verifier: verifier
    }
  });
  if (token.body.scope?.contracts?.[0]?.id !== "workout.record" || !token.body.refresh_token) {
    throw new Error(`Authorization did not return contract scope and refresh token: ${JSON.stringify(token.body)}`);
  }
  if (token.body.encryption?.protocol_version !== 1
      || token.body.encryption?.application_agreement_public_key !== applicationKey.agreementPublicKey
      || !token.body.grant_id) {
    throw new Error(`Authorization did not establish encrypted relay protocol 1: ${JSON.stringify(token.body)}`);
  }

  const duplicateCollectionPath = join(scratch, "workouts-duplicate");
  await run(cliBinary, [
    "--state-dir", stateDir,
    "connect",
    "collection", "create", duplicateCollectionPath,
    "--name", "Workouts"
  ]);
  await Promise.all([
    mkdir(join(duplicateCollectionPath, "_contracts"), { recursive: true }),
    mkdir(join(duplicateCollectionPath, "_types"), { recursive: true })
  ]);
  await writeFile(
    join(duplicateCollectionPath, "_contracts", "workout.record.md"),
    await readFile(join(collectionPath, "_contracts", "workout.record.md"))
  );
  await writeFile(
    join(duplicateCollectionPath, "_types", "workout.md"),
    await readFile(join(collectionPath, "_types", "workout.md"))
  );
  await stopAgent(agent);
  agent = startAgent(["--server-url", serverUrl], connectorToken);
  await poll(async () => {
    const current = await request("/v1/me", { cookie });
    return current.body.collections.filter(
      (candidate) => candidate.display_name === "Workouts"
    ).length === 2 ? current.body : null;
  }, "same-name collection metadata did not reach the portal");

  const portalVerifier = "portal-live-offer-pkce-verifier-with-forty-three-characters";
  const portalAuthorization = await startSignedWebAuthorization({
    application: application.body.application,
    redirectUri: manifest.redirectUri,
    verifier: portalVerifier,
    state: "portal-e2e",
    operations: ["describe"],
    cookie
  });
  const portalAuthorizationId = portalAuthorization.id;
  const portalRequest = await request(
    `/v1/authorization-requests/${portalAuthorizationId}`,
    { cookie }
  );
  const portalOffer = portalRequest.body.collections?.find(
    (candidate) => candidate.id === collection.id
  );
  if (!portalOffer?.offer_id || portalOffer.connector_name !== "MVP computer") {
    throw new Error(
      `The live connector did not offer its local collection to the portal: ${JSON.stringify(portalRequest.body)}`
    );
  }
  const portalBrowser = await chromium.launch({ headless: true });
  try {
    const portalContext = await portalBrowser.newContext();
    const cookieSeparator = cookie.indexOf("=");
    await portalContext.addCookies([{
      name: cookie.slice(0, cookieSeparator),
      value: cookie.slice(cookieSeparator + 1),
      url: serverUrl
    }]);
    const portalPage = await portalContext.newPage();
    await portalPage.goto(`${serverUrl}/authorize/${portalAuthorizationId}`);
    const duplicateRows = portalPage
      .locator(".collection-choice-list label")
      .filter({ hasText: "Workouts" });
    await duplicateRows.first().waitFor({ state: "visible" });
    const duplicateRowCount = await duplicateRows.count();
    if (duplicateRowCount !== 2) {
      throw new Error(
        `Expected two same-name collection rows, found ${duplicateRowCount}: `
        + JSON.stringify(portalRequest.body.collections)
      );
    }
    const radioLabels = await duplicateRows.locator("input[type=radio]").evaluateAll(
      (inputs) => inputs.map((input) =>
        input.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim() ?? ""
      )
    );
    if (radioLabels.length !== 2
        || radioLabels.some((label) => !label.includes("ID …"))
        || new Set(radioLabels).size !== 2) {
      throw new Error(`Same-name radio labels remained ambiguous: ${JSON.stringify(radioLabels)}`);
    }
    const details = await duplicateRows.locator("small").allTextContents();
    if (details.length !== 2 || new Set(details).size !== 2) {
      throw new Error(`Same-name collection details remained ambiguous: ${JSON.stringify(details)}`);
    }
    await portalContext.close();
  } finally {
    await portalBrowser.close();
  }
  await approvePortalAuthorization(portalAuthorizationId, cookie, {
    collection_id: portalOffer.id,
    offer_id: portalOffer.offer_id,
    operations: ["describe"]
  });
  const portalCallback = await finishSignedWebAuthorization(portalAuthorization);
  const portalToken = await request("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: portalCallback.searchParams.get("code"),
      client_id: appId,
      redirect_uri: manifest.redirectUri,
      code_verifier: portalVerifier
    }
  });
  const portalDescription = await signedGrantOperation(
    portalAuthorization,
    portalToken.body,
    collection.id,
    "describe",
    {}
  );
  const portalDescriptionBody = await portalDescription.json();
  if (portalDescription.status !== 200
      || portalDescriptionBody.result?.display_name !== "Workouts") {
    throw new Error(
      `Portal-activated local grant could not describe its collection: ${JSON.stringify(portalDescriptionBody)}`
    );
  }
  await cliJson(["access", "revoke", portalToken.body.grant_id]);

  const setupContractDocument = `---
kind: mdbase.contract
contract_type: record
id: planning.item
version: 1.0.0
name: Planning item
description: A titled item with a workflow state.
record_schema:
  dialect: json-schema-2020-12
  value:
    title: Planning item
    type: object
    required: [title, status]
    additionalProperties: false
    properties:
      title:
        title: Title
        description: The name people use for this item.
        type: string
      status:
        title: Workflow state
        description: Where this item is in the workflow.
        enum: [open, done]
---
`;
  const setupStarterDocument = `---
kind: mdbase.type
name: planning_item
version: 1
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [title, status]
    additionalProperties: true
    properties:
      title: { type: string }
      status: { enum: [open, done] }
implements:
  - contract: planning.item
    version: 1.0.0
    fields:
      title: title
      status: status
---
`;
  const setupContractDigest =
    "sha256:defbdfff727b8b6cc89041028878ddfc9fded9bd76e5fb106b90adfee3979a49";
  const setupResources = [
    {
      kind: "contract",
      source: "planning.contract.md",
      target: "_contracts/planning.item.md",
      document: setupContractDocument
    },
    {
      kind: "type",
      source: "planning.type.md",
      target: "_types/planning_item.md",
      document: setupStarterDocument
    }
  ];
  const setupApplication = await request("/v1/apps/register", {
    method: "POST",
    body: {
      manifest: {
        manifest_version: 1,
        id: "dev.mdbase.contract-setup-e2e",
        name: "Planning E2E",
        homepage: manifest.origin,
        redirect_uris: [manifest.redirectUri],
        requirements: {
          access: "contract",
          contracts: [{
            id: "planning.item",
            version: "1.0.0",
            digest: setupContractDigest
          }]
        },
        provisions: {
          type_packs: [{
            manifest: {
              kind: "mdbase.type-pack",
              id: "dev.mdbase.planning",
              version: "1.0.0",
              name: "Planning",
              resources: setupResources.map(({ document, ...resource }) => ({
                ...resource,
                mode: resource.kind === "type" ? "seed" : "managed",
                digest: `sha256:${createHash("sha256").update(document).digest("hex")}`
              }))
            },
            resources: setupResources.map(({ source, document }) => ({ source, document })),
            provides: [{
              id: "planning.item",
              version: "1.0.0",
              digest: setupContractDigest
            }]
          }]
        },
        notifications: { criteria: [] }
      }
    }
  });
  const setupVerifier = "contract-setup-e2e-verifier-with-forty-three-characters";
  const setupAuthorization = await startSignedWebAuthorization({
    application: setupApplication.body.application,
    redirectUri: manifest.redirectUri,
    verifier: setupVerifier,
    state: "setup-e2e",
    operations: ["describe", "query"],
    cookie
  });
  const setupAuthorizationId = setupAuthorization.id;
  const setupRequest = await poll(async () => {
    const current = await request(
      `/v1/authorization-requests/${setupAuthorizationId}`,
      { cookie }
    );
    return current.body.collections?.some((candidate) => candidate.id === collection.id)
      ? current
      : null;
  }, "contract-setup collection offer did not reach the portal");
  const setupOffer = setupRequest.body.collections.find(
    (candidate) => candidate.id === collection.id
  );
  const workoutCandidate = setupOffer?.types?.find((candidate) => candidate.name === "workout");
  if (!setupOffer?.offer_id
      || !workoutCandidate?.revision
      || workoutCandidate.path
      || workoutCandidate.definition
      || workoutCandidate.schema?.properties?.title?.type !== "string") {
    throw new Error(
      `The live setup offer was missing privacy-safe type metadata: ${JSON.stringify(setupOffer)}`
    );
  }
  const setupBrowser = await chromium.launch({ headless: true });
  try {
    const setupContext = await setupBrowser.newContext();
    const cookieSeparator = cookie.indexOf("=");
    await setupContext.addCookies([{
      name: cookie.slice(0, cookieSeparator),
      value: cookie.slice(cookieSeparator + 1),
      url: serverUrl
    }]);
    const setupPage = await setupContext.newPage();
    await setupPage.goto(`${serverUrl}/authorize/${setupAuthorizationId}`);
    await setupPage.locator(
      `.collection-choice-list input[value="${collection.id}"]`
    ).click();
    const editor = setupPage.locator(".contract-setup-editor");
    await editor.getByText("Help Planning E2E understand planning item").waitFor();
    const setupOptions = await editor.locator(".contract-setup-mode > label").allTextContents();
    if (!setupOptions[0]?.includes("Add Planning E2E’s starter type")) {
      throw new Error(`The default starter setup was not presented first: ${setupOptions}`);
    }
    if (!await editor.getByLabel("Add Planning E2E’s starter type").isChecked()) {
      throw new Error("The approval UI did not default to the application-provided starter type.");
    }
    await editor.getByLabel("Use an existing type").check();
    const mappings = await editor.locator(".contract-field-list select").evaluateAll(
      (selects) => selects.map((select) => select.value)
    );
    if (mappings.join(",") !== "title,status") {
      throw new Error(`The approval UI did not suggest exact field mappings: ${mappings}`);
    }
    await setupPage.getByRole("button", {
      name: "Set up and allow Planning E2E"
    }).waitFor();
    await setupContext.close();
  } finally {
    await setupBrowser.close();
  }
  await approvePortalAuthorization(setupAuthorizationId, cookie, {
    collection_id: setupOffer.id,
    offer_id: setupOffer.offer_id,
    operations: ["describe", "query"],
    contract_setups: [{
      contract: {
        id: "planning.item",
        version: "1.0.0",
        digest: setupContractDigest
      },
      mode: "existing",
      type_name: "workout",
      type_revision: workoutCandidate.revision,
      fields: { title: "title", status: "status" }
    }]
  });
  const setupCallback = await finishSignedWebAuthorization(setupAuthorization);
  const setupToken = await request("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: setupCallback.searchParams.get("code"),
      client_id: setupApplication.body.application.id,
      redirect_uri: manifest.redirectUri,
      code_verifier: setupVerifier
    }
  });
  const updatedWorkoutType = await readFile(
    join(collectionPath, "_types", "workout.md"),
    "utf8"
  );
  if (!updatedWorkoutType.includes("contract: planning.item")
      || !updatedWorkoutType.includes("contract: workout.record")
      || await fileExists(join(collectionPath, "_types", "planning_item.md"))
      || !await fileExists(join(collectionPath, "_contracts", "planning.item.md"))
      || setupToken.body.scope?.contracts?.[0]?.id !== "planning.item"
      || setupToken.body.scope?.contracts?.[0]?.implementations?.[0]?.type_name !== "workout") {
    throw new Error(`Existing-type setup did not produce the exact active scope: ${JSON.stringify({
      scope: setupToken.body.scope,
      updatedWorkoutType
    })}`);
  }
  const setupQuery = await signedGrantOperation(
    setupAuthorization,
    setupToken.body,
    collection.id,
    "query",
    { limit: 1 }
  );
  const setupQueryBody = await setupQuery.json();
  const setupResult = setupQueryBody.result?.result?.results?.[0];
  if (setupQuery.status !== 200
      || setupResult?.contract?.id !== "planning.item"
      || setupResult?.frontmatter?.title === undefined) {
    throw new Error(
      `The activated mapped contract could not query existing records: ${JSON.stringify(setupQueryBody)}`
    );
  }
  await cliJson(["access", "revoke", setupToken.body.grant_id]);

  relayContext = {
    store: applicationKeyStore,
    handle: applicationKey.handle,
    binding: {
      grantId: token.body.grant_id,
      applicationId: appId,
      encryption: token.body.encryption
    }
  };
  const hostileReady = await fetch(`${loopbackUrl}/v1/ready`, {
    headers: { origin: "https://hostile.example" }
  });
  if (hostileReady.status !== 403 || hostileReady.headers.has("access-control-allow-origin")) {
    throw new Error("Hostile origin could read loopback readiness");
  }
  const directReady = await fetch(`${loopbackUrl}/v1/ready`, {
    headers: { origin: directOrigin }
  });
  const directReadyBody = await directReady.json();
  if (directReady.status !== 200
      || directReady.headers.get("access-control-allow-origin") !== directOrigin
      || directReadyBody.loopback_protocol_version !== 1) {
    throw new Error(`Authorized origin could not discover direct access: ${JSON.stringify(directReadyBody)}`);
  }
  const refreshed = await request("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: appId
    }
  });
  const accessToken = refreshed.body.access_token;
  relayContext.binding.encryption = refreshed.body.encryption;
  const sdkStorage = new MemoryStorage();
  const sdkStoragePrefix = `mdbase-connect:${serverUrl}:bundle:${manifest.applicationManifest.id}`;
  sdkStorage.setItem(`${sdkStoragePrefix}:token:${collection.id}`, JSON.stringify({
    version: 1,
    accessToken,
    refreshToken: refreshed.body.refresh_token,
    clientId: appId,
    collectionId: collection.id,
    collectionName: collection.display_name,
    operations: refreshed.body.operations,
    scope: refreshed.body.scope,
    // Direct access remains usable while the cloud access token needs renewal.
    expiresAt: Date.now() - 1,
    refreshExpiresAt: Date.now() + refreshed.body.refresh_expires_in * 1_000,
    grantId: refreshed.body.grant_id,
    encryption: refreshed.body.encryption,
    applicationOrigin: refreshed.body.application_origin,
    keyHandle: applicationKey.handle,
    savedAt: Date.now()
  }));
  sdkStorage.setItem(`${sdkStoragePrefix}:connections`, JSON.stringify({
    version: 1,
    collectionIds: [collection.id]
  }));
  const sdk = new MdbaseConnect({
    serverUrl,
    manifest: manifest.applicationManifest,
    redirectUri: manifest.redirectUri,
    storage: sdkStorage,
    keyStore: applicationKeyStore,
    loopbackUrl
  });
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    if (!String(input).startsWith(`${loopbackUrl}/`)) return browserFetch(input, init);
    const headers = new Headers(init.headers);
    headers.set("origin", directOrigin);
    return browserFetch(input, { ...init, headers });
  };
  try {
    const connection = sdk.connection(collection.id);
    if (!connection) {
      throw new Error("Browser SDK did not restore the saved collection connection");
    }
    if (unwrapConnectOutcome(await connection.requestDirectAccess()) !== "available") {
      throw new Error("Browser SDK did not discover the direct connector");
    }
    const sdkQuery = unwrapConnectOutcome(await connection.query({ limit: 1_100 }));
    if (sdkQuery.results.length !== 1_000 || connection.route !== "direct") {
      throw new Error(
        "Browser SDK did not complete the 1,000-record query directly: " +
        JSON.stringify({
          records: sdkQuery.results.length,
          route: connection.route
        })
      );
    }
  } finally {
    globalThis.fetch = browserFetch;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const browserContext = await browser.newContext();
    await browserContext.grantPermissions(["local-network-access"], { origin: manifest.browserOrigin });
    const page = await browserContext.newPage();
    const browserPageErrors = [];
    const browserConsoleErrors = [];
    const browserRequestFailures = [];
    page.on("pageerror", (error) => browserPageErrors.push(error));
    page.on("console", (message) => {
      if (message.type() === "error") browserConsoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      browserRequestFailures.push(`${request.url()}: ${request.failure()?.errorText ?? "failed"}`);
    });
    page.on("response", (browserResponse) => {
      const contentType = browserResponse.headers()["content-type"] ?? "";
      if (browserResponse.request().resourceType() === "script"
          && !contentType.includes("javascript")) {
        browserRequestFailures.push(
          `${browserResponse.url()}: unexpected script content type ${contentType || "missing"}`
        );
      }
    });
    await page.goto(`${manifest.browserOrigin}/browser-e2e`);
    try {
      await page.waitForFunction(() => Boolean(globalThis.directHarness?.agreementPublicKey));
    } catch (error) {
      const failures = [
        ...browserPageErrors.map((failure) => failure.message),
        ...browserConsoleErrors,
        ...browserRequestFailures
      ];
      if (!failures.length) throw error;
      throw new Error(
        `Browser direct harness did not start: ${failures.join("; ")}`,
        { cause: error }
      );
    }
    const browserKeys = await page.evaluate(() => ({
      agreementPublicKey: globalThis.directHarness.agreementPublicKey,
      signingPublicKey: globalThis.directHarness.signingPublicKey
    }));
    const browserApplication = await request("/v1/apps/register", {
      method: "POST",
      body: { manifest: manifest.browserApplicationManifest }
    });
    const browserAppId = browserApplication.body.application.id;
    const browserVerifier = "browser-end-to-end-pkce-verifier-forty-three-chars";
    const browserOperations = [
      "describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename",
      "read_type", "create_type", "update_type", "list_views", "execute_view"
    ];
    const browserAuthorization = await startSignedWebAuthorization({
      application: browserApplication.body.application,
      redirectUri: manifest.browserRedirectUri,
      verifier: browserVerifier,
      state: "browser-e2e",
      operations: browserOperations,
      cookie,
      grantKey: browserKeys
    });
    const browserAuthorizationId = browserAuthorization.id;
    const browserRequest = await poll(async () => {
      const current = await request(
        `/v1/authorization-requests/${browserAuthorizationId}`,
        { cookie }
      );
      return current.body.collections?.some((candidate) => candidate.id === collection.id)
        ? current
        : null;
    }, "browser collection offer did not reach the portal");
    const browserOffer = browserRequest.body.collections.find(
      (candidate) => candidate.id === collection.id
    );
    await approvePortalAuthorization(browserAuthorizationId, cookie, {
      collection_id: browserOffer.id,
      offer_id: browserOffer.offer_id,
      operations: browserOperations
    });
    const browserCallback = await finishSignedWebAuthorization(browserAuthorization);
    const browserToken = await request("/oauth/token", {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        code: browserCallback.searchParams.get("code"),
        client_id: browserAppId,
        redirect_uri: manifest.browserRedirectUri,
        code_verifier: browserVerifier
      }
    });
    const browserResult = await page.evaluate(async (config) => {
      return globalThis.directHarness.exercise(config);
    }, {
      serverUrl,
      loopbackUrl,
      manifest: manifest.browserApplicationManifest,
      redirectUri: manifest.browserRedirectUri,
      loopbackUrl,
      token: {
        version: 1,
        accessToken: browserToken.body.access_token,
        refreshToken: browserToken.body.refresh_token,
        clientId: browserAppId,
        collectionId: browserToken.body.collection_id,
        collectionName: browserToken.body.collection_name,
        operations: browserToken.body.operations,
        scope: browserToken.body.scope,
        // Exercise genuine cloud-independent access, not merely deferred renewal.
        expiresAt: Date.now() - 60_000,
        refreshExpiresAt: Date.now() - 30_000,
        grantId: browserToken.body.grant_id,
        encryption: browserToken.body.encryption,
        applicationOrigin: browserToken.body.application_origin,
        keyHandle: "browser-e2e-grant",
        savedAt: Date.now()
      }
    });
    if (browserResult.status !== "available"
        || browserResult.route !== "direct"
        || browserResult.records !== 1_002
        || !browserResult.read
        || !browserResult.updated
        || !browserResult.renamed
        || !browserResult.validated
        || !browserResult.createdType
        || !browserResult.readType
        || !browserResult.updatedType
        || !browserResult.listedView
        || !browserResult.executedView
        || !browserResult.changed
        || !browserResult.deleted) {
      throw new Error(`Real browser direct-operation matrix failed: ${JSON.stringify(browserResult)}`);
    }

    const portableIntegrity = JSON.parse(await readFile(
      join(repoRoot, "packages", "client", "dist", "browser", "integrity.json"),
      "utf8"
    )).integrity;
    const portableFile = join(scratch, "portable-e2e.html");
    await writeFile(portableFile, `<!doctype html>
<meta charset="utf-8">
<title>Portable mdbase e2e</title>
<button id="connect">Connect</button>
<output id="code"></output>
<script src="${manifest.browserOrigin}/client/browser.js" integrity="${portableIntegrity}" crossorigin="anonymous"></script>
<script>
  const manifest = {
    manifest_version: 1,
    distribution: "portable",
    id: "dev.mdbase.portable-e2e",
    name: "Portable E2E",
    project_url: "https://apps.example/portable-e2e",
    requirements: { access: "full_collection", contracts: [] }
  };
  const manager = new MdbaseConnect.MdbaseConnect({
    serverUrl: ${JSON.stringify(serverUrl)},
    manifest,
    loopbackUrl: ${JSON.stringify(loopbackUrl)}
  });
  globalThis.portableHarness = {
    environment: manager.environment(),
    initialConnections: manager.connections().length
  };
  document.querySelector("#connect").onclick = () => {
    globalThis.portableHarness.pending = manager.authorize({
      operations: ["describe", "query"],
      onDeviceCode(authorization) {
        globalThis.portableHarness.authorization = authorization;
        document.querySelector("#code").textContent = authorization.userCode;
      },
      onFirstContact(challenge) {
        globalThis.portableHarness.firstContact = challenge;
      },
      openVerification() {}
    }).then(async (authorizationOutcome) => {
      const { connection } = MdbaseConnect.unwrapConnectOutcome(authorizationOutcome);
      const description = MdbaseConnect.unwrapConnectOutcome(await connection.describe());
      const query = MdbaseConnect.unwrapConnectOutcome(await connection.query({ limit: 2 }));
      globalThis.portableHarness.result = {
        collectionId: connection.collectionId,
        displayName: description.display_name,
        records: query.results.length,
        route: connection.route,
        connections: manager.connections().length
      };
    }).catch((error) => {
      globalThis.portableHarness.error = {
        code: error?.problem?.code ?? error?.code,
        message: error?.message
      };
    });
  };
</script>`);
    const portableUrl = pathToFileURL(portableFile).href;
    const portablePage = await browserContext.newPage();
    await portablePage.goto(portableUrl);
    await portablePage.waitForFunction(() => Boolean(globalThis.portableHarness));
    const portableEnvironment = await portablePage.evaluate(() => globalThis.portableHarness);
    if (portableEnvironment.environment?.applicationOrigin !== "null"
        || portableEnvironment.environment?.credentialStorage !== "memory"
        || portableEnvironment.initialConnections !== 0) {
      throw new Error(`Portable file defaults were not isolated: ${JSON.stringify(portableEnvironment)}`);
    }
    await portablePage.click("#connect");
    await portablePage.waitForFunction(
      () => Boolean(globalThis.portableHarness.authorization)
    );
    const portableAuthorization = await portablePage.evaluate(
      () => globalThis.portableHarness.authorization
    );
    const portableClaim = await request("/v1/device-authorization-requests/lookup", {
      method: "POST",
      cookie,
      body: { user_code: portableAuthorization.userCode }
    });
    const portableRequest = await poll(async () => {
      const current = await request(
        `/v1/authorization-requests/${portableClaim.body.request_id}`,
        { cookie }
      );
      return current.body.collections?.some((candidate) => candidate.id === collection.id)
        ? current
        : null;
    }, "portable collection offer did not reach the portal");
    const portableOffer = portableRequest.body.collections.find(
      (candidate) => candidate.id === collection.id
    );
    await approvePortalAuthorization(portableClaim.body.request_id, cookie, {
      collection_id: portableOffer.id,
      offer_id: portableOffer.offer_id,
      operations: ["describe", "query"]
    });
    await portablePage.waitForFunction(
      () => Boolean(globalThis.portableHarness.firstContact)
    );
    const portableFirstContact = await portablePage.evaluate(
      () => globalThis.portableHarness.firstContact
    );
    await cliJson([
      "trust", "accept", portableClaim.body.request_id,
      "--code", portableFirstContact.authenticationString
    ]);
    await portablePage.waitForFunction(
      () => Boolean(globalThis.portableHarness.result || globalThis.portableHarness.error),
      undefined,
      { timeout: 20_000 }
    );
    const portableResult = await portablePage.evaluate(
      () => globalThis.portableHarness
    );
    if (portableResult.error
        || portableResult.result?.collectionId !== collection.id
        || portableResult.result?.displayName !== "Workouts"
        || portableResult.result?.records !== 2
        || portableResult.result?.connections !== 1) {
      throw new Error(`Portable file authorization failed: ${JSON.stringify(portableResult)}`);
    }
    const separatePortablePage = await browserContext.newPage();
    await separatePortablePage.goto(portableUrl);
    const separatePortableState = await separatePortablePage.evaluate(
      () => globalThis.portableHarness
    );
    if (separatePortableState.initialConnections !== 0
        || separatePortableState.environment?.credentialStorage !== "memory") {
      throw new Error(`A separate file page inherited portable authorization: ${JSON.stringify(separatePortableState)}`);
    }
    await separatePortablePage.close();
    await portablePage.close();
    await browserContext.close();
  } finally {
    await browser.close();
  }

  const descriptionResponse = await rawOperation(collection.id, "describe", accessToken, {});
  const descriptionBody = await descriptionResponse.json();
  if (descriptionResponse.status !== 200
      || descriptionBody.result?.protocol_version !== 1
      || descriptionBody.result?.contracts?.[0]?.id !== "workout.record"
      || descriptionBody.result?.types?.length !== 1
      || descriptionBody.result?.types?.[0]?.schema?.properties?.title?.type !== "string") {
    throw new Error(`Unexpected collection description: ${JSON.stringify(descriptionBody)}`);
  }
  const changeCursor = descriptionBody.result.change_cursor;

  const create = await poll(async () => {
    const response = await rawOperation(collection.id, "create", accessToken, {
      path: "sessions/first.md",
      type: "workout",
      frontmatter: { title: "First connected workout", status: "open" }
    });
    return response.status === 200 ? response : null;
  }, "authorized relay create did not reach the connector");
  const createBody = await create.json();
  const firstRevision = createBody.result?.result?.revision;
  if (!firstRevision) throw new Error(`Create did not return a revision: ${JSON.stringify(createBody)}`);

  const createdChanges = await poll(async () => {
    const response = await rawOperation(collection.id, "changes", accessToken, {
      after: changeCursor
    });
    const body = await response.json();
    return body.result?.events?.some((event) => event.type === "mdbase.record.created" && event.payload.path === "sessions/first.md")
      ? body.result
      : null;
  }, "filesystem create event did not reach the change journal");
  const createdEvent = createdChanges.events.find((event) => event.type === "mdbase.record.created");
  if ("after" in createdEvent.payload || "before" in createdEvent.payload) {
    throw new Error("Change feed persisted record contents");
  }

  const update = await rawOperation(collection.id, "update", accessToken, {
    path: "sessions/first.md",
    patch: { status: "done" },
    if_revision: firstRevision
  });
  const updateBody = await update.json();
  const updatedRevision = updateBody.result?.result?.revision;
  if (update.status !== 200 || !updateBody.result?.valid || updatedRevision === firstRevision) {
    throw new Error(`Revision-safe update failed: ${JSON.stringify(updateBody)}`);
  }
  const conflict = await rawOperation(collection.id, "update", accessToken, {
    path: "sessions/first.md",
    patch: { title: "Lost update" },
    if_revision: firstRevision
  });
  const conflictBody = await conflict.json();
  if (conflict.status !== 200
      || conflictBody.result?.valid !== false
      || !conflictBody.result?.diagnostics?.some((diagnostic) => diagnostic.code === "concurrent_modification")) {
    throw new Error(`Stale revision was not rejected: ${JSON.stringify(conflictBody)}`);
  }

  const read = await rawOperation(collection.id, "read", accessToken, {
    path: "sessions/first.md"
  });
  const readBody = await read.json();
  if (read.status !== 200
      || readBody.result?.result?.frontmatter?.title !== "First connected workout"
      || readBody.result?.result?.frontmatter?.status !== "done") {
    throw new Error(`Unexpected relay read response: ${JSON.stringify(readBody)}`);
  }
  const bulkQuery = await rawOperation(collection.id, "query", accessToken, { limit: 1_100 });
  const bulkQueryBody = await bulkQuery.json();
  if (bulkQuery.status !== 200 || bulkQueryBody.result?.result?.results?.length < 1_001) {
    throw new Error(`Direct 1,000-record query was incomplete: ${JSON.stringify(bulkQueryBody)}`);
  }
  const downgrade = await fetch(`${serverUrl}/v1/authorities/${collection.id}/operations/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ path: "sessions/first.md" })
  });
  if (downgrade.status !== 426) {
    throw new Error(`Encrypted grant accepted plaintext downgrade with HTTP ${downgrade.status}`);
  }
  const replayEnvelope = await encryptRelayRequest(
    relayContext.store,
    relayContext.handle,
    relayContext.binding,
    "read",
    { path: "sessions/first.md" }
  );
  const replayFirst = await rawDirectEnvelope(replayEnvelope);
  if (replayFirst.status !== 200) throw new Error(`Fresh encrypted request failed with HTTP ${replayFirst.status}`);
  const replaySecond = await rawEncryptedEnvelope(collection.id, "read", accessToken, replayEnvelope);
  const replayFirstBody = await replayFirst.json();
  const replaySecondBody = await replaySecond.json();
  if (replaySecond.status !== 200
      || !sameEnvelope(replaySecondBody.envelope, replayFirstBody.envelope)) {
    throw new Error(`Direct-to-relay retry did not return the durable encrypted receipt: ${JSON.stringify({
      direct: replayFirstBody,
      relay: replaySecondBody,
      relayStatus: replaySecond.status
    })}`);
  }
  const tampered = {
    ...await encryptRelayRequest(
      relayContext.store,
      relayContext.handle,
      relayContext.binding,
      "read",
      { path: "sessions/first.md" }
    )
  };
  tampered.ciphertext = `${tampered.ciphertext.startsWith("A") ? "B" : "A"}${tampered.ciphertext.slice(1)}`;
  const tamperedResponse = await rawEncryptedEnvelope(collection.id, "read", accessToken, tampered);
  if (tamperedResponse.status !== 502
      || (await tamperedResponse.json()).error?.code !== "encrypted_relay_rejected") {
    throw new Error("Connector did not reject tampered ciphertext");
  }
  const privateRead = await rawOperation(collection.id, "read", accessToken, {
    path: "private.md"
  });
  const privateBody = await privateRead.json();
  if (privateRead.status !== 403 || privateBody.error?.code !== "access_denied") {
    throw new Error(`Contract scope exposed a private record: ${JSON.stringify(privateBody)}`);
  }
  const scopedQuery = await rawOperation(collection.id, "query", accessToken, {});
  const scopedQueryBody = await scopedQuery.json();
  if (scopedQuery.status !== 200
      || scopedQueryBody.result?.result?.results?.some((record) => record.path === "private.md")) {
    throw new Error(`Contract scope did not constrain query results: ${JSON.stringify(scopedQueryBody)}`);
  }

  await cliJson(["access", "pause", "true"]);
  const paused = await rawOperation(collection.id, "read", accessToken, {
    path: "sessions/first.md"
  });
  if (paused.status !== 403) throw new Error(`Paused local access returned HTTP ${paused.status}`);
  const localActivity = await cliJson(["activity", "--limit", "20"]);
  if (!localActivity.result.some((entry) => entry.outcome === "denied" && entry.operation === "read")) {
    throw new Error("Paused operation was not recorded in local activity");
  }
  await cliJson(["access", "pause", "false"]);

  await cliJson(["access", "revoke", token.body.grant_id]);
  const revoked = await rawOperation(collection.id, "read", accessToken, {
    path: "sessions/first.md"
  });
  if (revoked.status !== 403) throw new Error(`Revoked direct grant returned HTTP ${revoked.status}`);
  const revokedRefresh = await fetch(`${serverUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshed.body.refresh_token,
      client_id: appId
    })
  });
  if (revokedRefresh.status !== 400) {
    throw new Error(`Revoked grant refreshed with HTTP ${revokedRefresh.status}`);
  }
  process.stdout.write("mdbase connect end-to-end MVP path passed\n");
} finally {
  await onboardingContext?.close().catch(() => {});
  await onboardingBrowser?.close().catch(() => {});
  if (agent) await stopAgent(agent);
  if (browserManifestServer) {
    await new Promise((resolveClose) => browserManifestServer.close(resolveClose));
  }
  if (manifestServer) await new Promise((resolveClose) => manifestServer.close(resolveClose));
  await app.close();
  await database.end();
  await rm(scratch, { recursive: true, force: true });
}

async function startSignedWebAuthorization({
  application,
  redirectUri,
  verifier,
  state,
  operations,
  cookie,
  grantKey,
  collectionId
}) {
  const authorizationId = randomUUID();
  const installationHandle = `e2e-installation:${application.id}`;
  const installationKey = await applicationKeyStore.get(installationHandle)
    ?? await applicationKeyStore.create(installationHandle);
  const authorizationGrantKey = grantKey
    ?? await applicationKeyStore.create(`e2e-grant:${authorizationId}`);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const issuedAt = new Date();
  const proof = await signApplicationAuthorization({
    protocol_version: 1,
    authorization_id: authorizationId,
    application_id: application.id,
    application_manifest_digest: application.manifest_digest,
    application_installation_id: await applicationInstallationId(installationKey),
    installation_agreement_public_key: installationKey.agreementPublicKey,
    installation_signing_public_key: installationKey.signingPublicKey,
    grant_agreement_public_key: authorizationGrantKey.agreementPublicKey,
    grant_signing_public_key: authorizationGrantKey.signingPublicKey,
    flow: "authorization_code",
    authorization_nonce: randomBytes(32).toString("base64url"),
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 10 * 60 * 1_000).toISOString(),
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    requested_operations: operations,
    ...(collectionId ? { collection_id: collectionId } : {})
  }, installationKey);
  const started = await request("/oauth/authorization_request", {
    method: "POST",
    form: {
      client_id: application.id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      operations: operations.join(","),
      ...(collectionId ? { collection_id: collectionId } : {}),
      application_authorization: JSON.stringify(proof)
    }
  });
  if (started.body.authorization_id !== authorizationId) {
    throw new Error("The authorization service changed the signed authorization identity");
  }
  const claimed = await fetch(started.body.authorization_uri, {
    headers: { cookie },
    redirect: "manual"
  });
  if (claimed.status !== 302) {
    throw new Error(`Authorization claim returned HTTP ${claimed.status}`);
  }
  const claimedId = claimed.headers.get("location")?.split("/").at(-1);
  if (claimedId !== authorizationId) {
    throw new Error("The portal did not claim the exact signed authorization request");
  }
  return {
    id: authorizationId,
    application,
    installationKey,
    grantKey: authorizationGrantKey,
    redirectUri,
    verifier,
    state
  };
}

async function authorizationPoll(authorization) {
  const response = await fetch(`${serverUrl}/oauth/authorization_status`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: authorization.application.id,
      authorization_id: authorization.id,
      code_verifier: authorization.verifier
    })
  });
  const body = await response.json();
  if (response.ok) return { complete: body };
  if (body.error === "authorization_pending" || body.error === "slow_down") {
    return { pending: body };
  }
  throw new Error(`Authorization poll returned HTTP ${response.status}: ${JSON.stringify(body)}`);
}

async function finishSignedWebAuthorization(authorization) {
  let trustAccepted = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await authorizationPoll(authorization);
    if (status.complete) return new URL(status.complete.authorization_redirect);
    if (status.pending?.first_contact && !trustAccepted) {
      const code = await deriveFirstContactSas(
        status.pending.first_contact,
        "application",
        authorization.installationKey
      );
      await cliJson(["trust", "accept", authorization.id, "--code", code]);
      trustAccepted = true;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_100));
  }
  throw new Error("Application polling did not complete after portal approval and local trust");
}

async function approvePortalAuthorization(authorizationId, cookie, decision) {
  const response = await fetch(
    `${serverUrl}/v1/authorization-requests/${authorizationId}/approve`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(decision)
    }
  );
  const body = await response.json();
  if (response.ok || (response.status === 409 && body.error?.code === "trust_required")) {
    return body;
  }
  throw new Error(
    `Portal approval returned HTTP ${response.status}: ${JSON.stringify(body)}`
  );
}

async function cliJson(args) {
  const translated = [...args];
  if (translated[0] === "access" && translated[1] === "snapshot") {
    translated[1] = "list";
  } else if (translated[0] === "access" && translated[1] === "pause") {
    translated.splice(1, 2, translated[2] === "true" ? "pause" : "resume");
  }
  const result = await run(cliBinary, [
    "--state-dir",
    stateDir,
    "--json",
    "connect",
    ...translated
  ]);
  const parsed = JSON.parse(result.stdout);
  return { result: parsed };
}

function startAgent(extraArgs, connectorToken) {
  const child = spawn(cliBinary, [
    "--state-dir", stateDir,
    "connect",
    "daemon", "run",
    "--loopback-port", String(loopbackPort),
    ...extraArgs
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MDBASE_CONNECT_ENV: "test",
      MDBASE_CONNECT_SECRET_BACKEND: "insecure-test-file",
      ...(connectorToken
        ? { MDBASE_CONNECT_CONNECTOR_TOKEN: connectorToken }
        : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));
  return child;
}

async function stopAgent(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function waitForAgent() {
  await poll(async () => {
    try {
      await run(cliBinary, ["--state-dir", stateDir, "connect", "ping"]);
      return true;
    } catch {
      return null;
    }
  }, "local connector daemon did not start");
}

async function request(path, options = {}) {
  const headers = {};
  let body;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.authorization) headers.authorization = options.authorization;
  if (options.body) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }
  const response = await fetch(`${serverUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(responseBody)}`);
  return { response, body: responseBody };
}

async function rawEncryptedEnvelope(collectionId, operation, accessToken, envelope) {
  return fetch(`${serverUrl}/v1/authorities/${collectionId}/operations/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(envelope)
  });
}

async function signedGrantOperation(
  authorization,
  token,
  collectionId,
  operation,
  input
) {
  const binding = {
    grantId: token.grant_id,
    applicationId: authorization.application.id,
    encryption: token.encryption
  };
  const encryptedRequest = await encryptRelayRequest(
    applicationKeyStore,
    authorization.grantKey.handle,
    binding,
    operation,
    input
  );
  const response = await rawEncryptedEnvelope(
    collectionId,
    operation,
    token.access_token,
    encryptedRequest
  );
  const body = await response.json();
  if (!response.ok) return syntheticResponse(response.status, body);
  const decrypted = await decryptRelayResponse(
    applicationKeyStore,
    authorization.grantKey.handle,
    binding,
    encryptedRequest,
    body.envelope
  );
  return decrypted.ok
    ? syntheticResponse(200, { ok: true, result: decrypted.result })
    : syntheticResponse(403, { ok: false, problem: decrypted.problem });
}

async function rawDirectEnvelope(envelope) {
  if (!directOrigin) throw new Error("Direct origin is unavailable");
  return fetch(`${loopbackUrl}/v1/operations`, {
    method: "POST",
    headers: {
      origin: directOrigin,
      "content-type": "application/mdbase-connect+json"
    },
    body: JSON.stringify(envelope)
  });
}

async function rawOperation(collectionId, operation, accessToken, input) {
  if (!relayContext) {
    return rawEncryptedEnvelope(collectionId, operation, accessToken, input);
  }
  const encryptedRequest = await encryptRelayRequest(
    relayContext.store,
    relayContext.handle,
    relayContext.binding,
    operation,
    input
  );
  const response = await rawDirectEnvelope(encryptedRequest);
  if (!response.ok) return response;
  const routed = await response.json();
  const decrypted = await decryptRelayResponse(
    relayContext.store,
    relayContext.handle,
    relayContext.binding,
    encryptedRequest,
    routed.envelope
  );
  if (decrypted.ok) {
    return syntheticResponse(200, { ok: true, result: decrypted.result });
  }
    const denied = decrypted.problem.code === "access_paused" || decrypted.problem.code === "access_denied";
  return syntheticResponse(denied ? 403 : 502, { error: decrypted.problem });
}

function syntheticResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

function sameEnvelope(left, right) {
  const keys = Object.keys(left ?? {});
  return keys.length === Object.keys(right ?? {}).length
    && keys.every((key) => left[key] === right[key]);
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function poll(action, failureMessage) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await action();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(failureMessage);
}

async function availableTcpPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not reserve an end-to-end loopback port");
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function openManifestServer() {
  const primary = await openApplicationServer(
    "MVP Workout App",
    [{
      id: "workout.record",
      version: "1.0.0",
      digest: "sha256:ca1752bbf69314cc712c97ae25ca510dad0230a65653b664f405468c2cefbe16"
    }]
  );
  const browser = await openApplicationServer("Browser direct E2E", [], "full_collection");
  return {
    server: primary.server,
    browserServer: browser.server,
    origin: primary.origin,
    browserOrigin: browser.origin,
    applicationManifest: primary.manifest,
    browserApplicationManifest: browser.manifest,
    redirectUri: primary.redirectUri,
    browserRedirectUri: browser.redirectUri
  };
}

async function openApplicationServer(name, contracts, access) {
  const id = name === "Browser direct E2E"
    ? "dev.mdbase.browser-e2e"
    : "dev.mdbase.connect-e2e";
  const server = createServer(async (request, response) => {
    const address = server.address();
    const origin = `http://localhost:${address.port}`;
    if (request.url === "/client/browser.js") {
      response.setHeader("content-type", "text/javascript");
      response.setHeader("access-control-allow-origin", "*");
      response.end(await readFile(join(
        repoRoot,
        "packages",
        "client",
        "dist",
        "browser",
        "mdbase-connect.min.js"
      )));
      return;
    }
    const clientModule = request.url?.match(/^\/client\/([a-z0-9-]+\.js)$/)?.[1];
    if (clientModule) {
      response.setHeader("content-type", "text/javascript");
      response.end(await readFile(
        join(repoRoot, "packages", "client", "dist", clientModule)
      ));
      return;
    }
    const protocolModule = request.url?.match(/^\/protocol\/([a-z0-9.-]+\.js)$/)?.[1];
    if (protocolModule) {
      response.setHeader("content-type", "text/javascript");
      response.end(await readFile(
        join(repoRoot, "packages", "protocol", "dist", protocolModule)
      ));
      return;
    }
    if (request.url === "/browser-e2e") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html>
<meta charset="utf-8">
<script type="importmap">{"imports":{"@mdbase-dev/connect-protocol":"${origin}/protocol/index.js"}}</script>
<script type="module">
  import { MdbaseConnect, MemoryGrantKeyStore, unwrapConnectOutcome } from "${origin}/client/index.js";
  const keyStore = new MemoryGrantKeyStore();
  const key = await keyStore.create("browser-e2e-grant");
  globalThis.directHarness = {
    agreementPublicKey: key.agreementPublicKey,
    signingPublicKey: key.signingPublicKey,
    async exercise(config) {
      const storagePrefix = \`mdbase-connect:\${config.serverUrl}:bundle:\${config.manifest.id}\`;
      localStorage.setItem(
        \`\${storagePrefix}:token:\${config.token.collectionId}\`,
        JSON.stringify(config.token)
      );
      localStorage.setItem(
        \`\${storagePrefix}:connections\`,
        JSON.stringify({ version: 1, collectionIds: [config.token.collectionId] })
      );
      const connect = new MdbaseConnect({
        serverUrl: config.serverUrl,
        manifest: config.manifest,
        redirectUri: config.redirectUri,
        keyStore,
        loopbackUrl: config.loopbackUrl
      });
      const connection = connect.connection(config.token.collectionId);
      if (!connection) throw new Error("Saved browser connection was not restored");
      const status = unwrapConnectOutcome(await connection.requestDirectAccess());
      const description = unwrapConnectOutcome(await connection.describe());
      const created = unwrapConnectOutcome(await connection.create({
        path: "browser/direct.md",
        frontmatter: { type: "workout", title: "Real browser direct", status: "open" },
        body: "Created in Chromium."
      }));
      const revision = created.revision;
      const read = unwrapConnectOutcome(await connection.read({ path: "browser/direct.md" }));
      const updated = unwrapConnectOutcome(await connection.update({
        path: "browser/direct.md",
        patch: { status: "done" },
        if_revision: revision
      }));
      const readUpdated = unwrapConnectOutcome(await connection.read({ path: "browser/direct.md" }));
      const renamed = unwrapConnectOutcome(await connection.rename({
        from: "browser/direct.md",
        to: "browser/renamed.md"
      }));
      const query = unwrapConnectOutcome(await connection.query({ limit: 1_100 }));
      unwrapConnectOutcome(await connection.validate());
      const typeDocument = \`---
kind: mdbase.type
name: browsernote
version: 1
description: Browser note
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      title: { type: string }
---
\`;
      const createdType = unwrapConnectOutcome(await connection.createType({ document: typeDocument }));
      const readType = unwrapConnectOutcome(await connection.readType({ name: "browsernote" }));
      const updatedType = unwrapConnectOutcome(await connection.updateType({
        name: "browsernote",
        document: typeDocument.replace("Browser note", "Updated browser note"),
        if_revision: readType.revision
      }));
      const views = unwrapConnectOutcome(await connection.listViews());
      const executedView = unwrapConnectOutcome(await connection.executeView({
        path: "Views/workouts.base",
        view: "open-workouts"
      }));
      const changed = unwrapConnectOutcome(await connection.changes({ after: description.change_cursor }));
      const deleted = unwrapConnectOutcome(await connection.delete({ path: "browser/renamed.md" }));
      return {
        status,
        route: connection.route,
        records: query.results.length,
        read: read.body.includes("Created in Chromium"),
        updated: updated.frontmatter.status === "done" && readUpdated.frontmatter.status === "done",
        renamed: renamed.path === "browser/renamed.md",
        validated: true,
        createdType: createdType.path === "_types/browsernote.md",
        readType: readType.document.includes("Browser note"),
        updatedType: updatedType.document.includes("Updated browser note"),
        listedView: views.views.some((document) =>
            document.source.path === "Views/workouts.base"
              && document.views.some((view) => view.id === "open-workouts"
                && view.properties[1].key === "formula.lane"
                && view.properties[1].label === "Lane")
          ),
        executedView: executedView.results.length === 1000
          && executedView.meta.groups[0].values.status === "open"
          && executedView.results[0].values["formula.lane"] === "Ready"
          && !("file.path" in executedView.results[0].values),
        changed: changed.events.length > 0,
        deleted: deleted.deleted
      };
    }
  };
</script>`);
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      manifest_version: 1,
      id,
      name,
      homepage: origin,
      redirect_uris: [`${origin}/auth/mdbase/callback`],
      requirements: { contracts, ...(access ? { access } : {}) }
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const origin = `http://localhost:${address.port}`;
  const manifest = {
    manifest_version: 1,
    id,
    name,
    homepage: origin,
    redirect_uris: [`${origin}/auth/mdbase/callback`],
    requirements: { contracts, ...(access ? { access } : {}) }
  };
  return {
    server,
    origin,
    manifest,
    redirectUri: `${origin}/auth/mdbase/callback`
  };
}
