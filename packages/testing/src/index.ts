import {
  operationsForApplicationCapabilities,
  GRANT_ENCRYPTION_PROTOCOL_VERSION,
  type ApplicationCapabilityRequirements,
  type CollectionOperation,
  type FileCapability,
  type GrantEncryption,
  type GrantScope,
  type MdbaseAppManifest
} from "@mdbase-dev/connect-protocol";
import type { ConnectOutcome, ConnectProblem } from "@mdbase-dev/connect";
export {
  connectError,
  connectFailure,
  connectProblem,
  connectSuccess,
  operationProblem
} from "@mdbase-dev/connect/advanced";
import {
  connectorRelayFixture,
  generateConnectorKey,
  type FixtureRelayBinding,
  type MdbaseConnectorRelayFixture
} from "./relay.js";

export type {
  MdbaseConnectorRelayFixture,
  MdbaseFixtureRelayOperation
} from "./relay.js";

/** Test-only throwing adapter for concise assertions around typed SDK outcomes. */
export class ConnectTestOutcomeError extends Error {
  constructor(readonly problem: ConnectProblem) {
    super(problem.message);
    this.name = "ConnectTestOutcomeError";
  }
}

/** Require a successful SDK outcome in a test without adding a production adapter. */
export function requireConnectSuccess<Value>(outcome: ConnectOutcome<Value>): Value {
  if (!outcome.ok) throw new ConnectTestOutcomeError(outcome.problem);
  return outcome.value;
}

export interface MdbaseTestPage {
  evaluate<Result, Argument>(
    script: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result>;
}

export type MdbaseFixtureApplication =
  | { manifest: MdbaseAppManifest; manifestUrl?: never }
  | { manifestUrl: string; manifest: MdbaseAppManifest };

export interface MdbaseFixtureCollection {
  id: string;
  name: string;
  scope?: GrantScope;
  /** Override only to exercise reduced or stale grants. Defaults to manifest capabilities. */
  operations?: CollectionOperation[];
  fileCapability?: FileCapability;
}

export type MdbaseFixtureAuthority =
  | {
      kind: "hosted";
      operationsUrl: string;
      syncUrl: string;
      filesUrl: string;
      replicaId: string;
      accessToken?: string;
    }
  | { kind: "connector" };

export interface MdbaseBrowserFixtureOptions {
  serverUrl: string;
  application: MdbaseFixtureApplication;
  collection: MdbaseFixtureCollection;
  authority: MdbaseFixtureAuthority;
  accessToken?: string;
  expiresAt?: number;
  /** Begin with the browser's direct connector preference enabled. */
  directAccess?: "enabled" | "disabled";
}

export interface MdbaseBrowserFixtureController {
  /** Connector-side encrypted relay harness for route-level consumer tests. */
  relay?: MdbaseConnectorRelayFixture;
  /** Apply the fixture to the currently loaded app origin. */
  apply(page: MdbaseTestPage): Promise<void>;
  expire(page: MdbaseTestPage): Promise<void>;
  setOperations(page: MdbaseTestPage, operations: CollectionOperation[]): Promise<void>;
  remove(page: MdbaseTestPage): Promise<void>;
  isInstalled(page: MdbaseTestPage): Promise<boolean>;
}

interface BrowserFixtureSeed {
  indexKey: string;
  tokenKey: string;
  collectionId: string;
  keyHandle: string;
  authorityKind: MdbaseFixtureAuthority["kind"];
  connectorAgreementPublicKey?: string;
  directAccess?: "enabled" | "disabled";
  grantEncryptionProtocolVersion: GrantEncryption["protocol_version"];
  token: Record<string, unknown>;
}

/**
 * Atomically install a real Connect authorization on the currently loaded app
 * origin. Reload after this promise resolves to exercise application startup.
 * This package, rather than consumer tests, owns the private browser format.
 */
export async function installMdbaseBrowserFixture(
  page: MdbaseTestPage,
  options: MdbaseBrowserFixtureOptions
): Promise<MdbaseBrowserFixtureController> {
  const connector = options.authority.kind === "connector"
    ? await generateConnectorKey()
    : undefined;
  const seed = fixtureSeed(options, connector?.publicKey);
  const binding = await page.evaluate(writeSeed, seed);
  if (connector && !binding) {
    throw new Error("Connector browser fixtures require IndexedDB and WebCrypto.");
  }
  return {
    ...(connector && binding
      ? { relay: connectorRelayFixture(connector.privateKey, binding) }
      : {}),
    apply: (target) => target.evaluate(writeSeed, seed).then(() => undefined),
    expire: (target) => target.evaluate(updateToken, {
      tokenKey: seed.tokenKey,
      patch: { expiresAt: Date.now() - 1 }
    }).then(() => undefined),
    setOperations: (target, operations) => target.evaluate(updateToken, {
      tokenKey: seed.tokenKey,
      patch: { operations }
    }).then(() => undefined),
    remove: (target) => target.evaluate(removeSeed, seed).then(() => undefined),
    isInstalled: async (target) => Boolean(await target.evaluate(hasSeed, seed))
  };
}

function fixtureSeed(
  options: MdbaseBrowserFixtureOptions,
  connectorAgreementPublicKey?: string
): BrowserFixtureSeed {
  const manifestSource = "manifestUrl" in options.application
    ? options.application.manifestUrl
    : `bundle:${options.application.manifest.id}`;
  const prefix = `mdbase-connect:${stripTrailingSlash(options.serverUrl)}:${manifestSource}`;
  const requirements = options.application.manifest.requirements?.capabilities;
  const operations = options.collection.operations
    ?? operationsForManifest(requirements);
  const savedAt = Date.now();
  const accessToken = options.accessToken ?? "mdbase_test_application_access";
  return {
    indexKey: `${prefix}:connections`,
    tokenKey: `${prefix}:token:${options.collection.id}`,
    collectionId: options.collection.id,
    keyHandle: `fixture:${options.application.manifest.id}:${options.collection.id}`,
    authorityKind: options.authority.kind,
    grantEncryptionProtocolVersion: GRANT_ENCRYPTION_PROTOCOL_VERSION,
    ...(connectorAgreementPublicKey ? { connectorAgreementPublicKey } : {}),
    ...(options.directAccess ? { directAccess: options.directAccess } : {}),
    token: {
      version: 1,
      accessToken,
      clientId: options.application.manifest.id,
      collectionId: options.collection.id,
      collectionName: options.collection.name,
      operations,
      scope: options.collection.scope ?? { contracts: [], access: "full_collection" },
      expiresAt: options.expiresAt ?? savedAt + 60 * 60 * 1_000,
      savedAt,
      ...(options.collection.fileCapability
        ? { fileCapability: options.collection.fileCapability }
        : {}),
      ...(options.authority.kind === "hosted"
        ? {
            authority: {
              operationsUrl: options.authority.operationsUrl,
              syncUrl: options.authority.syncUrl,
              filesUrl: options.authority.filesUrl,
              replicaId: options.authority.replicaId,
              accessToken: options.authority.accessToken ?? "mdbase_test_authority_access"
            }
          }
        : {})
    }
  };
}

function operationsForManifest(
  requirements: ApplicationCapabilityRequirements | undefined
): CollectionOperation[] {
  if (!requirements) {
    throw new Error("Browser fixtures require a manifest semantic capability contract.");
  }
  return operationsForApplicationCapabilities(requirements);
}

async function writeSeed(seed: BrowserFixtureSeed): Promise<FixtureRelayBinding | undefined> {
  let token = { ...seed.token };
  let relayBinding: FixtureRelayBinding | undefined;
  if (
    typeof indexedDB !== "undefined"
    && typeof crypto !== "undefined"
    && crypto.subtle !== undefined
  ) {
    const agreement = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    ) as CryptoKeyPair;
    const agreementPrivateKey = await crypto.subtle.importKey(
      "pkcs8",
      await crypto.subtle.exportKey("pkcs8", agreement.privateKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"]
    );
    const agreementPublicKey = encode(
      await crypto.subtle.exportKey("raw", agreement.publicKey)
    );
    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    ) as CryptoKeyPair;
    const signingPrivateKey = await crypto.subtle.importKey(
      "pkcs8",
      await crypto.subtle.exportKey("pkcs8", signing.privateKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    const signingPublicKey = encode(
      await crypto.subtle.exportKey("raw", signing.publicKey)
    );
    const database = await openKeyDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("grant-keys", "readwrite");
      transaction.objectStore("grant-keys").put({
        handle: seed.keyHandle,
        agreementPrivateKey,
        agreementPublicKey,
        signingPrivateKey,
        signingPublicKey,
        counter: "0"
      });
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(
        transaction.error ?? new Error("Fixture key transaction aborted.")
      );
      transaction.oncomplete = () => resolve();
    });
    database.close();

    if (seed.authorityKind === "hosted") {
      token = {
        ...token,
        keyHandle: seed.keyHandle,
        authority: {
          ...(token.authority as Record<string, unknown>),
          proofPublicKey: signingPublicKey
        }
      };
    } else {
      if (!seed.connectorAgreementPublicKey) {
        throw new Error("Connector fixture key material is unavailable.");
      }
      const grantId = crypto.randomUUID();
      const encryption: GrantEncryption = {
        protocol_version: seed.grantEncryptionProtocolVersion,
        suite: "P256-HKDF-SHA256-AES256GCM",
        key_id: `fixture-${crypto.randomUUID()}`,
        scope_epoch: 1,
        connector_id: crypto.randomUUID(),
        collection_id: seed.collectionId,
        application_agreement_public_key: agreementPublicKey,
        connector_agreement_public_key: seed.connectorAgreementPublicKey
      };
      token = {
        ...token,
        grantId,
        keyHandle: seed.keyHandle,
        applicationOrigin: location.origin,
        encryption
      };
      relayBinding = {
        grantId,
        applicationId: String(token.clientId),
        encryption
      };
    }
  }
  localStorage.setItem(seed.indexKey, JSON.stringify({
    version: 1,
    collectionIds: [seed.collectionId]
  }));
  localStorage.setItem(seed.tokenKey, JSON.stringify(token));
  if (seed.directAccess) {
    localStorage.setItem(`mdbase-connect:direct:${location.origin}`, seed.directAccess);
  }
  return relayBinding;

  function encode(value: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(value)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  }

  function openKeyDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("mdbase-connect-keys", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("grant-keys")) {
          request.result.createObjectStore("grant-keys", { keyPath: "handle" });
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }
}

function updateToken(input: { tokenKey: string; patch: Record<string, unknown> }): void {
  const current = JSON.parse(localStorage.getItem(input.tokenKey) ?? "null") as Record<string, unknown> | null;
  if (!current) throw new Error("The mdbase browser fixture is not installed on this origin.");
  localStorage.setItem(input.tokenKey, JSON.stringify({ ...current, ...input.patch }));
}

async function removeSeed(seed: BrowserFixtureSeed): Promise<void> {
  localStorage.removeItem(seed.tokenKey);
  localStorage.removeItem(seed.indexKey);
  if (typeof indexedDB === "undefined") return;
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("mdbase-connect-keys", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("grant-keys")) {
        request.result.createObjectStore("grant-keys", { keyPath: "handle" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("grant-keys", "readwrite");
    transaction.objectStore("grant-keys").delete(seed.keyHandle);
    transaction.onerror = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
  database.close();
}

function hasSeed(seed: BrowserFixtureSeed): boolean {
  return localStorage.getItem(seed.tokenKey) !== null;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
